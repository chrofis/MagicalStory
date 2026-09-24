/**
 * Image Generation Module
 * Handles image generation, quality evaluation, editing, and retry logic
 * Extracted from server.js for maintainability
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const crypto = require('crypto');
const pLimit = require('p-limit');
const { log } = require('../utils/logger');
const { PROMPT_TEMPLATES, fillTemplate, guardPromptString, assertPromptFilled } = require('../services/prompts');
const { MODEL_DEFAULTS, withRetry } = require('./textModels');
const { buildCastIndex, resolveEntity } = require('./castResolver');
const { generateWithRunware, isRunwareConfigured, RUNWARE_MODELS } = require('./runware');
const { generateWithGrok, editWithGrok, isGrokConfigured, packReferences, cropToFrontColumn } = require('./grok');
const { MODEL_PRICING } = require('../config/models');
const { getCurrentLogger } = require('./generationLogger');
const r2Lib = require('./r2');
// Analyzer URL + in-flight cap now live in photoAnalyzerClient.js — shared
// with figure detection, compositing and garmentColourFix (one definition).
const { photoAnalyzerUrl: _photoAnalyzerUrl, withAnalyzerSlot } = require('./photoAnalyzerClient');
// sanitizeIssueForInpaint moved to imageCompositing.js with the rest of the
// mask/edit cluster; the inpaint prompt builders here still call it.
const { sanitizeIssueForInpaint } = require('./imageCompositing');
const { blackoutIssueRegions } = require('./imageInpainting');
const { buildEmptySceneVbGrid, buildPageCompositeRefs } = require('./referenceSheets');
const { GROK_ASPECT_PRESETS, closestGrokAspect } = require('./grokAspect');
const { assessImageResponse, describeImageBlock } = require('./imageReplyGuard');
const { assertLandmarkScene, pageNeedsPlate, pageLandmarkScene, toPlateDataUri, PlateRequiredError } = require('./landmarkScene');

/**
 * The evaluator-derived EVIDENCE fields that every result-assembly whitelist in
 * this module must carry.
 *
 * Each provider branch of `generateImageOnly` (and `evaluateImagesBatch`)
 * rebuilds its own whitelisted object from the `evaluateImageQuality` return —
 * "a field not listed here never reaches the stored version, however faithfully
 * the evaluator produced it." `notEvaluated` (the per-dimension "could not be
 * judged" record) and `threeStageResult` (the prompt-compliance judge's raw
 * record) are produced by the evaluator and listed by all three DOWNSTREAM
 * whitelists, yet no assembly here named them — so every stored page had
 * `notEvaluated: null` while the run's generationLog showed the recorder
 * firing. One helper spread into every branch so the next evidence field added
 * cannot go missing from four of five siblings.
 */
function carryEvalEvidence(qualityResult) {
  return {
    // null = the dimension record never reached us; [] = evaluated, nothing skipped.
    notEvaluated: qualityResult?.notEvaluated ?? null,
    // Stage-1 vision inventory + Stage-2 compliance JSON, verbatim.
    threeStageResult: qualityResult?.threeStageResult ?? null,
    // The required lettering every judge was told about (VB strings + a painted
    // cover title). The consolidator reads it so no repair plan removes it.
    requiredTexts: qualityResult?.requiredTexts ?? null,
  };
}
// Eval cluster now lives in evalPipeline.js (verbatim move; see its header).
// Destructured here both to re-export (facade — external top-level destructures
// in server.js / regeneration.js / entityConsistency.js depend on it) and
// because generation code below calls evaluateImageQuality directly.
// evalPipeline top-level-requires leaves only; its back-edges into this module
// are lazy require('./images') at call time, so this require is cycle-safe.
const {
  runVisualInventory,
  validateEmptyScene,
  capComplianceIdentitySeverity,
  evaluateThreeStage,
  sanitizeForGemini,
  evaluateImageQuality,
  IMAGE_QUALITY_THRESHOLD,
  // Forwarded only (facade): consumers import these from './images'.
  presenceCounterName,
  largestInteriorUniformFraction,
  buildEvalClothingContract,
  buildEvalRequiredObjects,
  buildExpectedCastBlock,
  resolveExpectedCastNames,
  reconcileDetectorCast,
  parseFixableIssues,
  derivePresenceFinding,
  supersedePresenceFindings,
  PRESENCE_DERIVED_MARKER,
  PRESENCE_COUNT_TYPES,
} = require('./evalPipeline');
// Forwarded by CONSTRUCTION, not by a hand-written list — the rule the
// storyHelpers facade settled on (docs/decisions.md, 2026-09-13). A name added
// to evalPipeline.js is exported here the moment it exists; a hand-maintained
// list silently binds `undefined` for whatever it forgets.
const evalPipelineModule = require('./evalPipeline');

// STR-6: image-prompt strings that used to be inline template literals in this
// file (Gemini/Grok repair, edit, bbox-refine, iterative placement, style
// transfer) now live in prompts/*.txt so they pass through the same reviewable
// template mechanism the Grok path already uses. Loaded once at module load and
// filled with fillTemplate() exactly like PROMPT_TEMPLATES. Kept local (not in
// services/prompts.js) so this refactor touches only images.js + new prompt
// files; the fill contract is identical.
const LOCAL_PROMPTS_DIR = path.join(__dirname, '../../prompts');
// Shared repair style-match guard (single source of truth in services/prompts.js)
// — substituted into the repair templates below so it can't drift from the ones
// loaded via PROMPT_TEMPLATES.
const { applyRepairStyleGuard } = require('../services/prompts');
const readPrompt = (f) => applyRepairStyleGuard(fs.readFileSync(path.join(LOCAL_PROMPTS_DIR, f), 'utf-8'));
const LOCAL_PROMPTS = {
  iterativePlacementPass1: readPrompt('iterative-placement-pass1.txt'),
  iterativePlacementPass2: readPrompt('iterative-placement-pass2.txt'),
  inpaintGrokRegions: readPrompt('inpaint-grok-regions.txt'),
  styleTransfer: readPrompt('style-transfer.txt'),
};

// Maps callGeminiAPIForImage's evaluationType to a stable function-name tag
// for the analyze-story-log cost rollup.
const EVAL_TYPE_TO_FUNC_NAME = {
  scene: 'page_image',
  page: 'page_image',
  cover: 'cover_image',
  avatar: 'avatar',
  iterate: 'page_image_iterate',
  empty: 'empty_scene',
  repair: 'character_repair'
};

function recordImageApiUsage(modelId, evaluationType, imageUsage) {
  const genLog = getCurrentLogger();
  if (!genLog) return;  // Not in a generation context (e.g. ad-hoc avatar request)
  const perImage = MODEL_PRICING[modelId]?.perImage ?? 0.04;
  const funcName = EVAL_TYPE_TO_FUNC_NAME[evaluationType] || evaluationType || 'image';
  genLog.apiUsage(funcName, modelId, {
    inputTokens: imageUsage.input_tokens || 0,
    outputTokens: imageUsage.output_tokens || 0,
    thinkingTokens: imageUsage.thinking_tokens || 0,
    calls: 1
  }, perImage);
}
const { MODEL_DEFAULTS: CONFIG_DEFAULTS, IMAGE_MODELS, resolveGrokImageModel, emptyScenePlateRouting, REPAIR_DEFAULTS, TEXT_MODELS } = require('../config/models');

const { createDiffImage } = require('./repairVerification');

// Bbox-detection cluster (VB-object grounding, bbox cache, fingerprint/pairing,
// detectAllBoundingBoxes, overlay rendering, enrichWithBoundingBoxes) moved
// VERBATIM to ./bboxDetection (god-file split Phase 3, 2026-08-11). Destructured
// here for images.js's own remaining call sites AND re-exported below (facade) —
// consumer imports from './images' are unchanged. FIGURE_COLORS moved with it.
const {
  parseVisualBibleObjects,
  resolveExpectedObjectLabels,
  buildObjectGroundingHints,
  _hashBboxKey,
  _bboxCacheGet,
  _bboxCacheSet,
  getBboxCacheStats,
  imageFingerprint,
  bboxPairsWith,
  restampDetectionForCoverText,
  detectionForVersion,
  detectAllBoundingBoxes,
  detectSubRegion,
  buildExpectedCharactersForBbox,
  createBboxOverlayImage,
  createSamInputOverlayImage,
  createCutoutSheetImage,
  escapeXml,
  enrichWithBoundingBoxes,
  FIGURE_COLORS,
  isMicroFigure,
  countRealFigures,
  vbNonHumanNames,
} = require('./bboxDetection');
// Forwarded by construction — see the note above evalPipelineModule.
const bboxDetectionModule = require('./bboxDetection');
const { findBadPages, selectCharRepairTasks } = require('./repairLogic');
// IMAGE_PROMPT for the judges = the string the model actually received.
// Sibling of resolveEvalSceneHint; see its comment in sceneMetadata.js.
const { resolveEvalImagePrompt, resolveEvalSceneDescription, castOfRewrittenBrief } = require('./sceneMetadata');
// storyHelpers functions (lazy-loaded to avoid circular dependencies)
let storyHelpersModule = null;
function getStoryHelpers() {
  if (!storyHelpersModule) {
    storyHelpersModule = require('./storyHelpers');
  }
  return storyHelpersModule;
}

// Character photo helpers
const { getFacePhoto, loadVbReferenceBytes } = require('./characterPhotos');

/**
 * Call Grok vision API for image analysis (OpenAI-compatible chat completions with images).
 * Converts Gemini parts format to Grok messages format and returns a Gemini-like response.
 * @param {string} modelKey - Model key in TEXT_MODELS (e.g., 'grok-4.3')
 * @param {string} modelId - Actual model ID (e.g., 'grok-4.3')
 * @param {Array} geminiParts - Gemini parts array (inline_data + text)
 * @param {string} promptText - The evaluation prompt text
 * @returns {Response} Fake Response object matching Gemini API shape
 */
async function callGrokVisionAPI(modelKey, modelId, geminiParts, promptText) {
  assertPromptFilled(geminiParts, 'images.callGrokVisionAPI');
  const xaiApiKey = process.env.XAI_API_KEY;
  if (!xaiApiKey) {
    log.error('❌ [GROK VISION] XAI_API_KEY not configured');
    return { ok: false, text: () => 'XAI_API_KEY not configured', json: () => ({}) };
  }

  // Convert Gemini parts to OpenAI messages format
  const content = [];
  for (const part of geminiParts) {
    if (part.inline_data) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` }
      });
    } else if (part.text) {
      content.push({ type: 'text', text: part.text });
    }
  }

  // No max_tokens (owner rule: no output caps): xAI defaults to the model's
  // own ceiling; a truncated eval is caught downstream by finishReason.
  const body = {
    model: modelId,
    temperature: 0.3,
    messages: [{ role: 'user', content }]
  };

  const startTime = Date.now();
  const response = await withRetry(async () => {
    return fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${xaiApiKey}`
      },
      body: JSON.stringify(body),
      // Eval calls had no timeout — a hung provider connection froze the whole
      // job forever (stuck-at-51% incident, 2026-07-07). Abort → withRetry
      // re-runs → on final failure eval is skipped and the job continues.
      signal: AbortSignal.timeout(120000)
    });
  }, { maxRetries: 2, baseDelay: 2000 });

  if (!response.ok) {
    const errText = await response.text();
    log.error(`❌ [GROK VISION] API error (${response.status}): ${errText.substring(0, 200)}`);
    return response;
  }

  const result = await response.json();
  const elapsed = Date.now() - startTime;
  const inputTokens = result.usage?.prompt_tokens || 0;
  const outputTokens = result.usage?.completion_tokens || 0;
  log.debug(`📊 [GROK VISION] ${modelKey} (${elapsed}ms): ${inputTokens} in, ${outputTokens} out`);

  // Convert Grok response to Gemini-compatible format so existing parsing works
  const text = result.choices?.[0]?.message?.content || '';
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: inputTokens,
        candidatesTokenCount: outputTokens,
        thoughtsTokenCount: 0
      }
    })
  };
}

/**
 * OpenRouter vision call in the same Gemini-compatible response shape as
 * callGrokVisionAPI, so the blind inventory can run a Chinese/OpenRouter
 * vision judge (Qwen3-VL, Qwen3.6 Plus, Kimi K2.6, MiniMax M3) through the
 * same parsing. Temperature 0 (SETTLED: eval judges run at temperature 0).
 */
async function callOpenRouterVisionAPI(modelKey, modelId, geminiParts, promptText, options = {}) {
  assertPromptFilled(geminiParts, 'images.callOpenRouterVisionAPI');
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    log.error('❌ [OPENROUTER VISION] OPENROUTER_API_KEY not configured');
    return { ok: false, text: () => 'OPENROUTER_API_KEY not configured', json: () => ({}) };
  }
  const content = [];
  for (const part of geminiParts) {
    if (part.inline_data) {
      content.push({ type: 'image_url', image_url: { url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` } });
    } else if (part.text) {
      content.push({ type: 'text', text: part.text });
    }
  }
  // No max_tokens (owner rule: no output caps): OpenRouter defaults to the upstream model's ceiling.
  // `reasoning` is a passthrough, absent unless a caller asks: thinking tokens
  // bill as output, and a describe-what-you-see pass has nothing to reason over.
  // Measure per model before trusting a level — on deepseek-v4-pro {enabled:false}
  // zeroed them while {effort:'low'} was ignored and cost 9x (textModels.js).
  const body = {
    model: modelId, temperature: 0, messages: [{ role: 'user', content }],
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
  };
  const startTime = Date.now();
  const response = await withRetry(async () => fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    // 120s like the Grok path, one retry: 3 of 20 Lab pages stalled on the
    // single upstream provider (experiment 1053), and the inventory has a
    // Gemini fallback waiting — a bounded wait then falling back beats a
    // nine-minute retry ladder on a page render's critical path.
    signal: AbortSignal.timeout(120000)
  }), { maxRetries: 1, baseDelay: 2000 });
  if (!response.ok) {
    const errText = await response.text();
    log.error(`❌ [OPENROUTER VISION] ${modelKey} API error (${response.status}): ${errText.substring(0, 200)}`);
    return response;
  }
  const result = await response.json();
  const inputTokens = result.usage?.prompt_tokens || 0;
  const outputTokens = result.usage?.completion_tokens || 0;
  log.debug(`📊 [OPENROUTER VISION] ${modelKey} (${Date.now() - startTime}ms): ${inputTokens} in, ${outputTokens} out`);
  const text = result.choices?.[0]?.message?.content || '';
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: inputTokens, candidatesTokenCount: outputTokens, thoughtsTokenCount: 0 }
    })
  };
}

// Gemini safety settings — used for all Gemini API calls to avoid content filtering
const GEMINI_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
];

// Helper: Check if a model supports thinking (includeThoughts in generationConfig)
function modelSupportsThinking(modelId) {
  const config = IMAGE_MODELS[modelId];
  return config?.supportsThinking === true;
}

/**
 * The sampling block for a Gemini image request — `{}` for Gemini 3.x.
 *
 * Google deprecated temperature/top_p/top_k on 2026-07-21 starting with Gemini
 * 3.6 Flash and 3.5 Flash-Lite: silently IGNORED on those models, HTTP 400 in a
 * later generation. Sending a different NUMBER does not help — the parameter
 * itself is what a future model rejects — so it has to be omitted.
 *
 * No behaviour change today: gemini-3-pro-image-preview declared temperature
 * 0.5 and Google was already discarding it, so the rendered image is the same.
 * What changes is that it stops being a time bomb. 2.5 still honours the
 * parameter and keeps sending it.
 *
 * Spread into generationConfig: `...geminiSampling(modelId)`.
 * See docs/decisions.md 2026-08-19 and scripts/admin/check-gemini-sampling.js.
 */
function geminiSampling(modelId) {
  const id = String(IMAGE_MODELS[modelId]?.modelId || modelId || '');
  if (/^gemini-3(\.\d+)?[-.]/.test(id)) return {};
  return { temperature: IMAGE_MODELS[modelId]?.temperature ?? 0.8 };
}

// Helper: Get system instruction for image generation (scenes, covers, repairs)
function getImageSystemInstruction() {
  if (!PROMPT_TEMPLATES.imageSystemInstruction) return null;
  return { parts: [{ text: PROMPT_TEMPLATES.imageSystemInstruction }] };
}

// Helper: Extract thinking text from Gemini response parts (thought: true)
function extractThinkingFromParts(parts, logPrefix = 'IMAGE GEN') {
  if (!parts || !Array.isArray(parts)) return null;
  const thoughts = parts
    .filter(p => p.thought && p.text)
    .map(p => p.text);
  if (thoughts.length === 0) return null;
  const thinkingText = thoughts.join('\n');
  log.debug(`🧠 [${logPrefix}] Thinking (${thinkingText.length} chars): ${thinkingText.substring(0, 200)}${thinkingText.length > 200 ? '...' : ''}`);
  log.verbose(`🧠 [${logPrefix}] Full thinking:\n${thinkingText}`);
  return thinkingText;
}

// =============================================================================
// PROMPT SANITIZATION FOR GEMINI SAFETY BLOCKS
// =============================================================================
// There is no word list here any more, and no local string surgery: a Gemini
// safety refusal gets exactly ONE retry, with the scene REWRITTEN by a text
// model (rewriteBlockedScene). The ladder lives in generateImageOnly.
//
// Two earlier rungs were deleted, both for the same reason — they bought a
// render by silently destroying the instructions the page needed:
//
//  • Generic "simplified scene" / "happy child in a magical setting" prompts
//    (former levels 2-3): the "successful" image had nothing to do with the
//    page — a fairy/bubbles picture shipped as a Tell-saga crossbow scene on
//    job_1781289599516 p4.
//
//  • PROBLEMATIC_WORDS + sanitizePromptLevel1 (deleted 2026-09-18, owner
//    approved): 78 words deleted whole-word, case-insensitively, from the WHOLE
//    prompt. Measured on stored data first — the list matched OUR OWN
//    INSTRUCTIONS far more often than any violence. `bleeding` is in
//    image-generation.txt's "filling the canvas, bleeding off all four edges"
//    (81.8% of stored staging page prompts, 27.5% of production ones); `weapon`
//    is in the text-zone rule "(hats, embroidery, patterns, weapon edges)";
//    `wound`, `hell`, `dead` and `shooting` match ordinary English and German
//    prose ("the rope is wound", "der Kiel ist hell", "the dead end of the
//    path", "her brow is shooting upward"). The rung fired 14 times on staging
//    and never once in production; it rescued 1 of those 14, and THAT render
//    went out without the full-bleed instruction. The rewrite rung rescued 2.
//    A refusal now escalates straight to the rewrite.

// =============================================================================
// LRU CACHE IMPLEMENTATION
// Prevents memory leaks by limiting cache size and implementing eviction
// =============================================================================

const IMAGE_CACHE_MAX_SIZE = parseInt(process.env.IMAGE_CACHE_MAX_SIZE) || 100;
const REF_CACHE_MAX_SIZE = parseInt(process.env.REF_CACHE_MAX_SIZE) || 200;
const CACHE_TTL_MS = parseInt(process.env.IMAGE_CACHE_TTL_MS) || 60 * 60 * 1000; // 1 hour default

/**
 * Simple LRU Cache with TTL support
 * Evicts least recently used entries when max size is reached
 */
class LRUCache {
  constructor(maxSize, ttlMs = 0, name = 'cache') {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
    this.name = name;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check TTL expiration
    if (this.ttlMs > 0 && Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, { value: entry.value, timestamp: entry.timestamp });
    this.hits++;
    return entry.value;
  }

  getStats() {
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? ((this.hits / total) * 100).toFixed(1) : 0;
    return { hits: this.hits, misses: this.misses, total, hitRate, size: this.cache.size };
  }

  resetStats() {
    this.hits = 0;
    this.misses = 0;
  }

  set(key, value) {
    // Delete first to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      log.debug(`🗑️ [CACHE] Evicted oldest entry: ${oldestKey?.substring(0, 16)}...`);
    }

    this.cache.set(key, { value, timestamp: Date.now() });
  }

  has(key) {
    if (!this.cache.has(key)) return false;
    const entry = this.cache.get(key);
    if (this.ttlMs > 0 && Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

// Image cache to avoid regenerating identical images (with LRU eviction)
const imageCache = new LRUCache(IMAGE_CACHE_MAX_SIZE, CACHE_TTL_MS, 'image');

// Cache for compressed reference images (with LRU eviction)
const compressedRefCache = new LRUCache(REF_CACHE_MAX_SIZE, CACHE_TTL_MS, 'ref');


// Maximum mask coverage (%) before skipping repair - larger masks degrade quality
// Inpainting works best for small, targeted fixes. For large areas, regenerate the image instead.

/**
 * Hash image data for comparison/caching
 * @param {string} imageData - Base64 image data URL
 * @returns {string} Short hash (8 characters)
 */
function hashImageData(imageData) {
  if (!imageData || typeof imageData !== 'string') return null;
  const data = r2Lib.stripDataUriPrefix(imageData);
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 8);
}

/**
 * Generate cache key for image generation
 * Creates a hash from prompt + character photo hashes + page number
 * @param {string} prompt - The image generation prompt
 * @param {Array} characterPhotos - Array of character photos (URLs or {name, photoUrl} objects)
 * @param {string|null} sequentialMarker - Optional marker for sequential mode
 * @param {number|null} pageNumber - Optional page number to ensure unique cache keys per page
 */
function generateImageCacheKey(prompt, characterPhotos = [], sequentialMarker = null, pageNumber = null, ...extraMarkers) {
  // Hash each photo and sort them for consistency
  // Supports both: array of URLs (legacy) or array of {name, photoUrl} objects (new)
  const photoHashes = characterPhotos
    .map(p => typeof p === 'string' ? p : p?.photoUrl)
    .filter(url => url && typeof url === 'string' && url.startsWith('data:image'))
    .map(photoUrl => {
      const base64Data = r2Lib.stripDataUriPrefix(photoUrl);
      return crypto.createHash('sha256').update(base64Data).digest('hex').substring(0, 16);
    })
    .sort()
    .join('|');

  // Combine prompt + photo hashes + sequential marker + page number
  // Page number ensures different pages never get the same cached image
  const extraSuffix = extraMarkers.filter(Boolean).join('|');
  const combined = `${prompt}|${photoHashes}|${sequentialMarker || ''}|${pageNumber !== null ? `page${pageNumber}` : ''}${extraSuffix ? `|${extraSuffix}` : ''}`;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Crop image to change aspect ratio for sequential mode
 * Used in sequential mode to prevent AI from copying too much from the reference image
 * Crops 15% from top and 15% from bottom to force regeneration while preserving central context
 * @param {string} imageBase64 - Base64 encoded image (with data URI prefix)
 * @returns {Promise<string>} Cropped base64 encoded image with data URI prefix
 */
async function cropImageForSequential(imageBase64) {
  try {
    // Remove data URI prefix if present
    const base64Data = r2Lib.stripDataUriPrefix(imageBase64);

    // Convert base64 to buffer
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Get image metadata to know dimensions
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;

    if (!width || !height) {
      log.warn('⚠️ [CROP] Could not get image dimensions, returning original');
      return imageBase64;
    }

    // Crop 15% from top and 15% from bottom (30% total) - focuses on central content
    const cropTop = Math.floor(height * 0.15);
    const cropBottom = Math.floor(height * 0.15);
    const newHeight = height - cropTop - cropBottom;

    log.debug(`✂️ [CROP] Cropping reference image: ${width}x${height} → ${width}x${newHeight} (removed ${cropTop}px from top, ${cropBottom}px from bottom)`);

    // Crop the image - extract from cropTop offset
    const croppedBuffer = await sharp(imageBuffer)
      .extract({ left: 0, top: cropTop, width: width, height: newHeight })
      .png()
      .toBuffer();

    // Convert back to base64 with data URI prefix
    const croppedBase64 = `data:image/png;base64,${croppedBuffer.toString('base64')}`;

    return croppedBase64;
  } catch (err) {
    log.error('❌ [CROP] Error cropping image:', err.message);
    // Return original image if cropping fails
    return imageBase64;
  }
}

/**
 * Compress PNG image to JPEG format
 * Converts base64 PNG to JPEG with compression to reduce file size
 * @param {string} pngBase64 - Base64 encoded PNG image (with or without data URI prefix)
/**
 * @param {number} quality - JPEG quality (1-100, default 85)
 * @param {number|null} maxDimension - Maximum width/height in pixels (null = no resize)
 * @returns {Promise<string>} Base64 encoded JPEG image with data URI prefix
 */
async function compressImageToJPEG(pngBase64, quality = 85, maxDimension = null) {
  try {
    // Validate input is a string
    if (!pngBase64 || typeof pngBase64 !== 'string') {
      log.error(`❌ [COMPRESSION] Invalid input: expected string, got ${typeof pngBase64}`);
      throw new Error(`compressImageToJPEG requires a string, got ${typeof pngBase64}`);
    }

    // Remove data URI prefix if present and detect original mime type
    const mimeMatch = pngBase64.match(/^data:(image\/\w+);base64,/);
    const originalMimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const base64Data = r2Lib.stripDataUriPrefix(pngBase64);

    // Convert base64 to buffer
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Get original size
    const originalSizeKB = (imageBuffer.length / 1024).toFixed(2);

    // Skip compression for small images (< 100KB) - they're already optimized
    const SMALL_IMAGE_THRESHOLD_KB = 100;
    if (imageBuffer.length < SMALL_IMAGE_THRESHOLD_KB * 1024) {
      log.debug(`🗜️  [COMPRESSION] Skipping - image already small (${originalSizeKB} KB < ${SMALL_IMAGE_THRESHOLD_KB} KB)`);
      // Return original with correct format
      if (pngBase64.startsWith('data:')) {
        return pngBase64;
      }
      return `data:${originalMimeType};base64,${base64Data}`;
    }

    // Skip re-compression for JPEG images already at target size
    // Avoids double JPEG compression quality loss (e.g., face photos stored at 768x768 JPEG 95%)
    const isJpeg = originalMimeType === 'image/jpeg';
    if (isJpeg) {
      const metadata = await sharp(imageBuffer).metadata();
      const isSmallEnough = !maxDimension || (metadata.width <= maxDimension && metadata.height <= maxDimension);
      if (isSmallEnough) {
        log.debug(`🗜️  [COMPRESSION] Skipping re-compression - already JPEG ${metadata.width}x${metadata.height} (${originalSizeKB} KB)`);
        if (pngBase64.startsWith('data:')) {
          return pngBase64;
        }
        return `data:image/jpeg;base64,${base64Data}`;
      }
    }

    // Build sharp pipeline
    let pipeline = sharp(imageBuffer);

    // Resize if maxDimension is specified
    if (maxDimension && maxDimension > 0) {
      pipeline = pipeline.resize({
        width: maxDimension,
        height: maxDimension,
        fit: 'inside',
        withoutEnlargement: true
      });
    }

    // Compress to JPEG
    const compressedBuffer = await pipeline
      .jpeg({ quality: quality, progressive: true })
      .toBuffer();

    // Convert back to base64
    const compressedBase64 = compressedBuffer.toString('base64');
    const compressedSizeKB = (compressedBuffer.length / 1024).toFixed(2);
    const reductionPercent = ((1 - compressedBuffer.length / imageBuffer.length) * 100).toFixed(1);

    log.debug(`🗜️  [COMPRESSION] PNG ${originalSizeKB} KB → JPEG ${compressedSizeKB} KB (${reductionPercent}% reduction)`);

    return `data:image/jpeg;base64,${compressedBase64}`;
  } catch (error) {
    log.error('❌ [COMPRESSION] Error compressing image:', error);
    throw error;
  }
}


/**
 * Rewrite a blocked scene description to be safer while preserving the story moment
 * @param {string} sceneDescription - The original scene that was blocked
 * @param {Function} callTextModel - Function to call text model API
 * @returns {Promise<string>} - The rewritten, safer scene description
 */
async function rewriteBlockedScene(sceneDescription, callTextModel) {
  log.debug(`🔄 [REWRITE] Rewriting blocked scene to be safer...`);
  log.debug(`🔄 [REWRITE] Original: ${sceneDescription.substring(0, 100)}...`);

  try {
    const rewritePrompt = fillTemplate(PROMPT_TEMPLATES.rewriteBlockedScene, {
      SCENE_DESCRIPTION: sceneDescription
    });

    const rewriteResult = await callTextModel(rewritePrompt, null, require('../config/models').resolveSceneRewriteModel(), { usageLabel: 'scene_rewrite' });
    const rewrittenScene = rewriteResult.text;

    // Log token usage
    if (rewriteResult.usage) {
      log.debug(`📊 [REWRITE] Token usage - input: ${rewriteResult.usage.input_tokens || 0}, output: ${rewriteResult.usage.output_tokens || 0}`);
    }

    log.info(`✅ [REWRITE] Scene rewritten: ${rewrittenScene.substring(0, 100)}...`);
    return { text: rewrittenScene.trim(), usage: rewriteResult.usage };
  } catch (error) {
    log.error(`❌ [REWRITE] Failed to rewrite scene:`, error.message);
    throw error;
  }
}

/**
 * Resolve the output aspect ratio for an image-gen call: an explicit override
 * always wins, otherwise fall back to the configured default for the target
 * (avatar / cover / page) — all three live in one place (MODEL_DEFAULTS).
 * Single source of truth for the block that was copy-pasted across every
 * Grok/Gemini dispatch inside callGeminiAPIForImage.
 */
function resolveOutputAspect(evaluationType, aspectRatioOverride) {
  return aspectRatioOverride
    || (evaluationType === 'avatar' ? MODEL_DEFAULTS.avatarAspect
        : evaluationType === 'cover' ? MODEL_DEFAULTS.coverAspect
        : MODEL_DEFAULTS.pageAspect);
}

/**
 * Truncate a prompt to a backend's max length, emitting the same "Prompt too
 * long" warning every dispatch site used to hand-roll. Returns the prompt
 * unchanged when it already fits. `modelName` is optional — when supplied the
 * warning appends " for <model>" (three sites logged it, the gen-only Gemini
 * site did not), so the emitted string stays byte-identical to each original.
 * The caller keeps any follow-on side effect (e.g. updating parts[0] on the
 * Gemini path) by testing `result !== prompt`, which is true iff truncated.
 */
function truncatePromptForModel(prompt, maxPromptLength, logLabel, modelName = null) {
  if (prompt.length <= maxPromptLength) return prompt;
  const forClause = modelName != null ? ` for ${modelName}` : '';
  log.warn(`✂️ [${logLabel}] Prompt too long (${prompt.length} chars), truncating to ${maxPromptLength}${forClause}`);
  return prompt.substring(0, maxPromptLength - 3) + '...';
}

// Over-budget prompts are SHRUNK, never blind-cut: the blunt substring cut
// dropped whole tail sections — a page whose 9.4k prompt was cut at 7.5k lost
// its entire ART STYLE block and rendered photographic on every roll (3/3
// measured), and lost its object specs (map drawn with a ship instead of the
// described bridge). Order: deterministic dedupe → LLM compression → a
// section-aware cut that always preserves the tail sections as the final
// guarantee. truncatePromptForModel above remains only as the last-resort
// fallback inside that guarantee.
function dedupeIdenticalBullets(prompt) {
  // Merge "- Name: body" bullet lines whose body text is identical (sibling
  // characters often share verbatim proportion boilerplate) into one line:
  // "- Name1, Name2: body".
  const lines = prompt.split('\n');
  const seen = new Map(); // body -> first line index
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- ([^:]{1,40}): (.{40,})$/);
    if (!m) continue;
    const body = m[2];
    if (seen.has(body)) {
      const j = seen.get(body);
      lines[j] = lines[j].replace(/^- ([^:]{1,40}):/, (_, names) => `- ${names}, ${m[1]}:`);
      lines[i] = null;
    } else {
      seen.set(body, i);
    }
  }
  return lines.filter(l => l !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}

// THE CUT DROPS EXACT BLOCKS, RANKED — GENERIC GUIDANCE BEFORE PAGE FACTS.
//
// Two faults, both reproduced on staging job_1789853503332_riqncqg1i (18 pages,
// grok cap 7,900):
//
//   1. Every page's built prompt ran 8.5-10.2k, and the four blocks at the top
//      of the old order — Composition, HEIGHT ORDER, AGE & PROPORTIONS and the
//      plate-vs-identity reference rule — were deleted on all fifteen pages
//      that stored a prompt. Those four are PAGE FACTS: who is how tall, how
//      old, which attached photo is a place and which is a person. The blocks
//      that survived were the generic rule paragraphs, byte-identical on every
//      page of every book. The ranking was upside down, so it is inverted
//      here: when a page does not fit, generic guidance yields to the facts of
//      that page (docs/decisions.md, 2026-09-21).
//   2. A block's extent was found by scanning forward to the next marker in a
//      HAND-KEPT list. Any block header missing from that list was swallowed by
//      the drop in front of it: the front cover of the same story lost its
//      whole cast block — every garment, age and height — because the
//      `**CHARACTERS IN THIS IMAGE` header was not a marker. Blocks are now
//      removed by their EXACT text, read from the template or constant that emitted them,
//      so there is no range to overrun and no list to keep in sync.
//
// The scene prose, the reference-card colour map, the cast blocks, REQUIRED
// OBJECTS, ART STYLE, the season, the text area, the shot rule and EXACT POSES
// are not droppable at all: the prose IS the page, the colour map is what pairs
// each baked card with a name, and the rest is what the page was commissioned
// with.
//
// NOR ARE THE PARITY ANCHORS (2026-09-23). NO MARKS and HANDS are one constant
// each, shared with the judge rule they answer (D-24, D-16b — sibling-registry
// set `page-image-generator-vs-critics`). They were third and fourth in this
// list, so an over-cap page was judged for two rules its illustrator never
// received: staging job_1790100385959_1nitlympp p12 and all three of its covers
// lost both (docs/audits/prompt-audit-2026-09-23/08-page-images.md S3,
// 09-covers.md C3). REQUIRED TEXT is protected the same way. None of them is a
// unit below, and cutBlocks() throws if a unit would ever remove one.
const {
  NO_CHARACTER_MARKING_RULE, HANDS_HOLD_ONLY_NAMED_RULE,
  COMPOSITION_HEADER, COMPOSITION_FACING_BULLET, COMPOSITION_GROUND_BULLET, COMPOSITION_SIZE_BULLET, COUNTS_RULE,
} = require('./promptBuilders');

/**
 * A literal paragraph of prompts/image-generation.txt, by its opening text.
 * Reading the rule from the template it was emitted from is what keeps this
 * list from going stale: a reworded rule stops matching HERE, loudly, instead
 * of leaving a drop that silently never fires.
 */
const IMAGE_GENERATION_TEMPLATE_ON_DISK = fs.readFileSync(path.join(LOCAL_PROMPTS_DIR, 'image-generation.txt'), 'utf-8');

function templateParagraph(prefix) {
  // The loaded template when the loader has run, the file on disk otherwise —
  // ONE source either way (services/prompts loads this same file; a DB override
  // only ever replaces its content). Non-image callers of the shrinker (the
  // Grok edit body, the composite blend prompt) reach this before any template
  // is loaded, and they carry none of these blocks, so a missing paragraph in
  // the ON-DISK copy is the only thing that means the list has gone stale.
  const tpl = PROMPT_TEMPLATES.imageGeneration || IMAGE_GENERATION_TEMPLATE_ON_DISK;
  const para = tpl.split(/\n{2,}/).map(x => x.trim()).find(x => x.startsWith(prefix));
  if (!para) {
    throw new Error(`prompt-shrink: prompts/image-generation.txt has no paragraph starting "${prefix}" — the cut order is stale`);
  }
  return para;
}

/** An exact string, removed wherever it occurs. */
function exactTextUnit(text) {
  return (s) => {
    const n = s.split(text).length - 1;
    return { text: n ? s.split(text).join('') : s, entitled: n * text.length };
  };
}

/** A block found by a regex (one match) — the cast-derived page facts. */
function regexUnit(re) {
  return (s) => {
    const m = s.match(re);
    return m ? { text: s.replace(re, ''), entitled: m[0].length } : { text: s, entitled: 0 };
  };
}

/**
 * ONE BULLET of the Composition block (promptBuilders.buildCompositionBlock).
 * Composition used to go whole — 1,176 chars on p12 of staging
 * job_1790100385959_1nitlympp, which was ~110 chars over the cap when its turn
 * came — so a page lost its feet-on-the-ground rule to pay for one sentence.
 * Bullets go one at a time; the header goes with the last one, so no empty
 * heading is ever sent.
 */
function compositionBulletUnit(bullet) {
  const escaped = COMPOSITION_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const orphanHeader = new RegExp(`^${escaped}[ \\t]*(?!\\n- )(?=\\n|$)`, 'm');
  const needle = `\n${bullet}`;
  return (s) => {
    const n = s.split(needle).length - 1;
    if (!n) return { text: s, entitled: 0 };
    let out = s.split(needle).join('');
    let entitled = n * needle.length;
    if (orphanHeader.test(out)) {
      out = out.replace(orphanHeader, '');
      entitled += COMPOSITION_HEADER.length;
    }
    return { text: out, entitled };
  };
}

/**
 * THE CUT ORDER — what shrinkPromptForModel removes, and in which order, when a
 * built image prompt is over the model's cap (Grok: 7,900 chars,
 * models.js maxPromptLength). ONE list. The shrinker walks it top to bottom and
 * stops the moment the prompt fits; docs/image-generation-methods.html and
 * docs/prompt-inventory.md render THIS array (scripts/admin/sync-prompt-cut-order-docs.js,
 * pinned by tests/unit/prompt-cut-order-docs.test.ts) — there is no second copy.
 *
 * Each step removes its block's EXACT text and nothing else. A step whose block
 * is not in the prompt (a cover has no facing bullet or COUNTS; a one-character
 * page has no HEIGHT ORDER) removes nothing and is not logged.
 *
 * THE RANK (2026-09-23, docs/decisions.md "The shrink ranks its cuts"): a block
 * goes early when something else in the prompt already carries most of what it
 * says or when it binds few pages; the page facts — height, age, the
 * reference-photo binding, the frame rule — go last, as the 2026-09-21 ranking
 * set them. `approxChars` is the block's size on a typical page (staging
 * job_1790100385959_1nitlympp, measured 2026-09-24).
 */
const PROMPT_CUT_ORDER = [
  {
    label: 'COUNTS',
    what: 'the "three or fewer" counting rule',
    why: 'binds only a page whose prose states a number of like things; never built on a cover',
    approxChars: 235,
    unit: () => exactTextUnit(COUNTS_RULE),
  },
  {
    label: 'Composition: size',
    what: 'the vessel / building / vehicle true-size bullet',
    why: 'the REQUIRED OBJECTS scale riders and DEPTH AND SIZE ("a size stated for an element always wins") state it per element',
    approxChars: 305,
    unit: () => compositionBulletUnit(COMPOSITION_SIZE_BULLET),
  },
  {
    label: 'Composition: facing',
    what: 'the "faces the target, not the camera" bullet',
    why: 'yields to every declared facing, and EXACT POSES / EXPRESSIONS AND EYES declare one per figure; never built on a cover',
    approxChars: 367,
    unit: () => compositionBulletUnit(COMPOSITION_FACING_BULLET),
  },
  {
    label: 'DEPTH AND SIZE',
    what: 'the foreground / midground / background definitions',
    why: 'defines the brief\'s depth words; the prose still places every figure',
    approxChars: 647,
    unit: () => exactTextUnit(templateParagraph('**DEPTH AND SIZE:**')),
  },
  {
    label: 'Composition: ground',
    what: 'the feet-on-the-ground bullet (the header goes with it)',
    why: 'the one feet-on-the-ground rule for pages and covers; kept longer than the generic rules above',
    approxChars: 600,
    unit: () => compositionBulletUnit(COMPOSITION_GROUND_BULLET),
  },
  {
    label: 'REQUIRED CAST',
    what: 'every named character in frame, exactly one of each, nobody added',
    why: 'the generator half of D-03 / D-04b; the prose and the character lines still name the cast, so it is the last generic rule to go',
    approxChars: 500,
    unit: () => exactTextUnit(templateParagraph('**REQUIRED CAST:**')),
  },
  // Page facts. Last to go.
  {
    label: 'HEIGHT ORDER',
    what: 'the shortest-to-tallest line',
    why: 'a page fact: the relative size the height judge compares',
    approxChars: 140,
    unit: () => regexUnit(/^\*\*HEIGHT ORDER[^\n]*\n/m),
  },
  {
    label: 'AGE & PROPORTIONS',
    what: 'the per-age head-count proportions',
    why: 'a page fact: without it an infant is drawn as a preschooler',
    approxChars: 485,
    unit: () => regexUnit(/^AGE & PROPORTIONS[\s\S]*?(?=\n\n|$)/m),
  },
  {
    label: 'reference-photo rule',
    what: 'which attached photo is a place and which is a person',
    why: 'a page fact: the plate-vs-identity binding of the attached images',
    approxChars: 512,
    unit: () => exactTextUnit(templateParagraph('When the FIRST reference photo')),
  },
  {
    label: 'single-illustration rule',
    what: 'one full-bleed picture, no lettering, ids are not painted',
    why: 'the frame rule; the very last block the cut may spend',
    approxChars: 503,
    unit: () => exactTextUnit(templateParagraph('Generate a SINGLE illustration')),
  },
];

/**
 * NEVER CUT. None of these is a step above, and no step may reach one:
 * cutBlocks() throws if a step would remove an exact-text entry (`text`).
 * Entries with a `marker` open the PROTECTED TAIL — everything from the first
 * of them to the end of the prompt (protectedTailStart). Once every step has
 * run, only the text before that tail (the scene prose and the page's own
 * lines) is trimmed, at a sentence boundary; if the tail alone leaves no room
 * the render fails loudly instead (owner, 2026-09-23).
 */
const PROMPT_NEVER_CUT = [
  { label: 'NO MARKS', why: 'generator half of D-24 (sibling-registry page-image-generator-vs-critics parity anchor)', text: () => NO_CHARACTER_MARKING_RULE },
  { label: 'HANDS', why: 'generator half of D-16b (same parity anchor set)', text: () => HANDS_HOLD_ONLY_NAMED_RULE },
  { label: 'REQUIRED TEXT', why: 'the baked cover title and any lettering a Visual Bible element must carry (SETTLED: baked title)', text: () => '**REQUIRED TEXT:**' },
  { label: 'REQUIRED OBJECTS', why: 'the commissioned elements of the page', marker: '**REQUIRED OBJECTS' },
  { label: 'SEASON', why: 'the book-wide season, even against a reference photo from another season', marker: '**SEASON:**' },
  { label: 'LIGHT', why: "the page's declared time of day and weather, which wins over the plate's light (sceneLight.js)", marker: '**LIGHT:**' },
  { label: 'COMPOSITION GUIDELINES', why: 'a cover\'s own composition: title-safe top third, group, bottom margin', marker: '**COMPOSITION GUIDELINES:**' },
  { label: 'ART STYLE', why: 'the style the book is commissioned in', marker: '**ART STYLE' },
  { label: 'SHOT', why: 'the page\'s declared framing (a cover carries none)' },
  { label: 'EXACT POSES / EXPRESSIONS AND EYES', why: 'the declared pose and gaze per figure' },
];

let CUT_BLOCKS = null;
function cutBlocks() {
  if (CUT_BLOCKS) return CUT_BLOCKS;
  const units = PROMPT_CUT_ORDER.map((step, i) => ({ step: i + 1, label: step.label, apply: step.unit() }));
  // The anchors are protected by construction; this makes a step added later
  // that would reach one fail at the first shrink instead of shipping.
  const tpl = PROMPT_TEMPLATES.imageGeneration || IMAGE_GENERATION_TEMPLATE_ON_DISK;
  for (const keep of PROMPT_NEVER_CUT.filter(k => k.text)) {
    const anchor = keep.text();
    let probe = `${tpl}\n\n${anchor}`;
    for (const unit of units) probe = unit.apply(probe).text;
    if (!probe.includes(anchor)) {
      throw new Error(`prompt-shrink: a cut step removes ${keep.label} — it is on the never-cut list`);
    }
  }
  CUT_BLOCKS = units;
  return CUT_BLOCKS;
}

/**
 * Collapsing `\n{3,}` after a removal legitimately costs a few characters more
 * than the block itself. This is the allowance for that, and nothing else.
 */
const BLANK_RUN_SLACK = 64;

/**
 * @returns {{ text: string, dropped: string[], droppedSteps: Array<{step:number,label:string,chars:number}>, proseCut: number }}
 */
function sectionAwareCut(prompt, maxLen, logLabel) {
  let out = prompt;
  const dropped = [];
  const droppedSteps = [];
  for (const block of cutBlocks()) {
    if (out.length <= maxLen) break;
    const before = out.length;
    // What this drop is ENTITLED to remove: its own text, every occurrence of
    // it, and nothing else — reported by the unit that removes it, so the
    // check below has a number rather than a hope.
    const applied = block.apply(out);
    const entitled = applied.entitled;
    out = applied.text.replace(/\n{3,}/g, '\n\n');
    const removed = before - out.length;
    if (removed > entitled + BLANK_RUN_SLACK) {
      // A DROP THAT REACHES PAST ITS OWN BLOCK IS A DELETED PAGE, NOT A SHRINK.
      // This is the 2026-09-21 production failure made unreintroducible: the
      // cut of the day found a block's extent by scanning forward to the next
      // header in a hand-kept list, so `AGE & PROPORTIONS` on a page whose
      // following headers were not in that list swallowed WORN ITEMS, the scene
      // prose, the per-character lines, Setting/Camera/Depth and the character
      // reference list in one slice — ~5k chars reported as one dropped block.
      // Trial job_1789975900382_dyc1g7wue shipped pages 4 and 5 that way, the
      // illustrator never told what the page was. Exact-text removal makes that
      // impossible today; this makes it impossible to bring back, and it throws
      // rather than degrades: a prompt that does not state the page is not a
      // cheaper prompt, it is the wrong picture (CLAUDE.md — no fallbacks).
      throw new Error(`prompt-shrink: dropping "${block.label}" removed ${removed} chars but that block is only ${entitled} — the cut reached past it into the page's own facts`);
    }
    if (removed > 0) {
      dropped.push(block.label);
      droppedSteps.push({ step: block.step, label: block.label, chars: removed });
    }
  }

  let proseCut = 0;
  if (out.length > maxLen) {
    // Nothing droppable is left and the page still does not fit. Trim the SCENE
    // PROSE at a sentence boundary — never mid-word, never a character index
    // (owner, 2026-08-17): the head is written in reading order, so slicing at
    // a byte offset deletes the LAST-described characters outright while the
    // evaluator still scores the render against a contract they were cut from.
    const tailStart = protectedTailStart(out);
    if (tailStart < 0) {
      // Not an image prompt (the Grok edit body, the composite blend): no
      // section markers, nothing must-keep to protect.
      const truncated = truncatePromptForModel(out, maxLen, logLabel);
      return { text: truncated, dropped, droppedSteps, proseCut: out.length - truncated.length };
    }
    const tail = out.slice(tailStart);
    const headBudget = maxLen - tail.length - 5;
    if (headBudget < 500) {
      // The MUST-KEEP tail alone leaves no room for the scene. A blunt cut here
      // would delete must-keep text (it used to: truncatePromptForModel sliced
      // the end off, ART STYLE first). Fail the render instead (owner,
      // 2026-09-23: must-keep sections are never cut; if it cannot fit, fail
      // loudly).
      throw new Error(`prompt-shrink [${logLabel}]: ${out.length} chars after every drop, cap ${maxLen}; the must-keep sections alone are ${tail.length} chars — refusing to cut them`);
    }
    let head = out.slice(0, tailStart);
    const keep = head.slice(0, headBudget);
    const lastStop = Math.max(keep.lastIndexOf('. '), keep.lastIndexOf('.\n'));
    const cut = lastStop > headBudget * 0.5 ? lastStop + 1 : headBudget;
    proseCut = head.length - cut;
    head = head.slice(0, cut);
    out = head.trimEnd() + '\n' + tail;
  }

  log.warn(`✂️ [${logLabel}] Section-aware cut: ${prompt.length}→${out.length} chars`
    + (droppedSteps.length ? `, cut in order: ${describeCutSteps(droppedSteps)}` : '')
    + (proseCut ? `, AND ${proseCut} chars of scene prose — a character may be missing` : ''));
  return { text: out, dropped, droppedSteps, proseCut };
}

/** "#1 COUNTS (-235) > #2 Composition: size (-305)" — step numbers are PROMPT_CUT_ORDER positions. */
function describeCutSteps(steps) {
  return steps.map(s => `#${s.step} ${s.label} (-${s.chars})`).join(' > ');
}

/**
 * THE MUST-KEEP SECTIONS (the `marker` entries of PROMPT_NEVER_CUT). Everything from the first of these to the end of the
 * prompt is the protected tail: the shrink never trims into it, and fails
 * loudly rather than cut it (sectionAwareCut). REQUIRED OBJECTS and ART STYLE
 * were the only two markers until 2026-09-23, so a prompt with no REQUIRED
 * OBJECTS block — every full-path cover — had its tail start at ART STYLE, and
 * the last-resort prose trim ate the cover's Visual Bible block, SEASON and
 * COMPOSITION GUIDELINES first, because the template places them just before
 * ART STYLE: staging job_1789853503332_riqncqg1i's back cover shipped with all
 * three gone (owner, 2026-09-23: must-keep on every cover path). Every cover now
 * carries REQUIRED OBJECTS like a page, and the separate cover block (KEY STORY
 * ELEMENTS) is deleted.
 */
const MUST_KEEP_MARKERS = PROMPT_NEVER_CUT.filter(k => k.marker).map(k => k.marker);

/** Index where the protected tail begins (the earliest must-keep marker), or -1. */
function protectedTailStart(prompt) {
  const hits = MUST_KEEP_MARKERS.map(m => prompt.indexOf(m)).filter(i => i >= 0);
  return hits.length ? Math.min(...hits) : -1;
}

/**
 * The scene block of a prompt: everything strictly before the protected tail
 * (protectedTailStart). Returns '' when there is no tail marker, so a caller
 * can tell "no scene block found" from a real one.
 */
function sceneHeadOf(prompt) {
  const tailStart = protectedTailStart(prompt);
  return tailStart > 0 ? prompt.slice(0, tailStart).trim() : '';
}

/**
 * FIT A BUILT IMAGE PROMPT INTO THE MODEL'S CHARACTER CAP.
 *
 * Two deterministic steps, in order: merge duplicated bullet bodies, then drop
 * ranked blocks (sectionAwareCut). There is no third, paid step. A deepseek
 * head-rewrite lived between them until 2026-09-21; measured over staging
 * job_1789853503332_riqncqg1i it made 34 calls ($0.13, ~180 s) whose output
 * appears in ZERO stored prompts — on pages the head budget was under its own
 * 1,500-char floor so it never ran, and on covers it ran, was rejected for
 * overshooting, and the cut ran anyway. See docs/decisions.md 2026-09-21.
 *
 * @param {Object|null} meta - optional out-param. Whenever this function
 *   actually CHANGES the prompt, `meta.compressedScene` receives the SCENE
 *   BLOCK OF THE STRING IT RETURNS — the scene prose the image model really
 *   got. Stamping only the (now deleted) LLM branch was measured leaving the
 *   field null on the one over-cap page of staging job_1789348171785_9oxos7dwv
 *   (p7, 8,002 chars against grok-imagine-image-2.0's 7,900 cap): dedupe alone
 *   brought it to 7,242, so nothing recorded that the sent prose differed from
 *   the built prose at all. The batch image eval judges the render against that
 *   description rather than the pre-shrink one
 *   (sceneMetadata.resolveEvalSceneDescription). It is the head ALONE: taken
 *   from strictly before the `**REQUIRED OBJECTS` / `**ART STYLE` tail split,
 *   so it carries no ART STYLE block, and it is not a second copy of the whole
 *   prompt.
 */
async function shrinkPromptForModel(prompt, maxPromptLength, logLabel, modelName = null, meta = null) {
  if (!prompt || prompt.length <= maxPromptLength) return prompt;

  // 1. Deterministic: merge duplicated bullet bodies, collapse blank runs.
  let out = dedupeIdenticalBullets(prompt);
  if (out.length <= maxPromptLength) {
    log.info(`✂️ [${logLabel}] Prompt ${prompt.length}→${out.length} chars via dedupe (budget ${maxPromptLength})`);
    recordPromptShrink({ logLabel, modelName, branch: 'dedupe', before: prompt.length, after: out.length,
      cap: maxPromptLength, dropped: [], proseCut: 0 });
    if (meta) meta.compressedScene = sceneHeadOf(out) || undefined;
    return out;
  }

  // 2. Guarantee: drop ranked blocks, generic guidance before page facts.
  const cut = sectionAwareCut(out, maxPromptLength, logLabel);
  recordPromptShrink({ logLabel, modelName, branch: 'cut', before: prompt.length, after: cut.text.length,
    cap: maxPromptLength, dropped: cut.dropped, droppedSteps: cut.droppedSteps, proseCut: cut.proseCut });
  if (meta) meta.compressedScene = sceneHeadOf(cut.text) || undefined;
  return cut.text;
}

/**
 * THE SHRINK IS A GENERATION EVENT, NOT A LOG LINE.
 *
 * Which blocks a page lost, and whether its prose was trimmed, decides what the
 * illustrator was actually asked for — and the judges score the render against
 * it. That was visible only as a `log.warn` in a Railway stream nobody reads
 * per page, so a whole book could ship with AGE & PROPORTIONS missing from
 * every prompt and nothing in the story record said so.
 */
function recordPromptShrink({ logLabel, modelName, branch, before, after, cap, dropped, droppedSteps = [], proseCut }) {
  const genLog = getCurrentLogger();
  if (!genLog) return;  // not in a generation context (ad-hoc Lab / script call)
  const details = { label: logLabel, model: modelName || null, branch, before, after, cap,
    charsCut: before - after, dropped, droppedSteps, proseCut };
  const msg = `${logLabel}: ${before}→${after} chars (cap ${cap}) via ${branch}`
    + (droppedSteps.length ? `, cut in order: ${describeCutSteps(droppedSteps)}` : '')
    + (proseCut ? `, ${proseCut} chars of scene prose trimmed` : '');
  if (dropped.length || proseCut) genLog.warn('prompt_shrink', msg, null, details);
  else genLog.info('prompt_shrink', msg, null, details);
}


/**
 * Collect the data:image reference URLs from a characterPhotos array (each
 * entry is either a raw data-URI string or an object with a `photoUrl`).
 * Shared by the Runware dispatch of both image-gen entry functions and the
 * Grok avatar branch, so the extraction rule lives in one place.
 */
function extractDataImageUrls(characterPhotos) {
  const referenceImages = [];
  if (characterPhotos && characterPhotos.length > 0) {
    for (const photoData of characterPhotos) {
      const photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
      if (photoUrl && photoUrl.startsWith('data:image')) {
        referenceImages.push(photoUrl);
      }
    }
  }
  return referenceImages;
}

/**
 * Shared provider-dispatch core for the two image-gen entry functions
 * (`callGeminiAPIForImage` — eval path — and `generateImageOnly` — gen-only).
 *
 * Owns the ENTIRE Grok→Gemini→Runware selection ladder that both used to
 * re-implement in parallel: backend resolution, primary Runware, primary Grok,
 * Gemini `parts` construction, model-id resolution + prompt truncation,
 * model-routed Runware, model-routed Grok, and the non-Gemini→Gemini model swap.
 * It performs the actual provider API call for the Runware/Grok branches and
 * invokes `onImageReady`, but does NO quality eval and NO caching — those stay
 * in the wrappers so each keeps its own cache namespace and result shape.
 *
 * Returns one of:
 *   - a RAW generation result for a Runware/Grok branch:
 *       { provider, imageData, modelId, usage, packedRefs, promptSent }
 *     provider ∈ 'runware-primary' | 'grok-primary' | 'runware-routed' | 'grok-routed'
 *   - a Gemini fallback SENTINEL when no upstream provider produced an image:
 *       { provider: 'gemini', parts, modelId, effectivePrompt }
 *     The wrapper runs its own terminal Gemini fetch — the two differ (gen-only
 *     runs a 3-level sanitization retry loop; the eval path is a single-shot
 *     fallback that also calls recordImageApiUsage), so that one branch is not
 *     shared. Everything up to it (parts already built, model id resolved +
 *     swapped, prompt truncated) is done here.
 *
 * Every place the two original ladders differed is a documented `opts` field
 * each wrapper passes its own value for, so behavior is byte-preserved.
 */
async function _dispatchImageGeneration(prompt, characterPhotos = [], opts = {}) {
  const {
    logLabel,                            // 'IMAGE GEN' | 'IMAGE GEN-ONLY'
    verbose = false,                     // eval path: verbose logs + per-photo hash log + model name in truncate warning
    previousImage = null,
    imageModelOverride = null,
    imageBackendOverride = null,
    landmarkPhotos = [],
    visualBibleGrid = null,
    sceneBackground = null,
    textAreaMask = null,                 // gen-only threads this into primary-Grok packReferences
    // What a raw landmark photo may be on this call when no plate is sent:
    // 'plate' (this call renders the plate) | 'castless' (cast-0 page) | null.
    // See server/lib/landmarkScene.js — anything else with a photo throws.
    landmarkScene = null,
    onImageReady = null,
    outputAspect,                        // pre-resolved aspect (eval: resolveOutputAspect(evalType, override); gen-only: aspectRatio option)
    evaluationType = null,               // used only for the primary-Grok log line (eval path)
    usePadExtension = false,             // gen-only pads scene-plate slot 0 (both Grok branches)
    avatarMode = false,                  // eval path avatar-slices refs in model-routed Grok
    pageLabel = '',                      // Grok packReferences pageLabel
    defaultModel,                        // eval path cover-aware; gen-only pageImage
    includeSceneBackgroundPart = false,  // gen-only adds a [Background] Gemini part
    vbColumnFraction = null,             // Test Lab only: widen the VB element column
    maxRefSlots = null,                  // Test Lab only: raise packReferences/editWithGrok's
                                          // slot budget above the production default of 3
                                          // (xAI's edit cap is 5). null = production default.
    // Out-param: receives `compressedScene` when the prompt went over the
    // model's cap and shrinkPromptForModel LLM-compressed the scene prose.
    // Callers stamp it onto the page record so the batch eval judges the render
    // against the description that was actually sent.
    promptMeta = null,
  } = opts;

  // PLATE OR FAIL: a landmark photo with no plate and no declared role never
  // reaches a provider (server/lib/landmarkScene.js).
  assertLandmarkScene({ landmarkPhotos, sceneBackground, landmarkScene, label: logLabel || 'IMAGE' });

  // Whether slot-0 scene plates get magenta-extension padding (gen-only only).
  const slot0IsScenePlate = usePadExtension && !!(sceneBackground || (Array.isArray(landmarkPhotos) && landmarkPhotos.length) || previousImage);

  // Priority: explicit backend override > the overridden model's OWN backend >
  // CONFIG_DEFAULTS > 'gemini'. Deriving the backend from imageModelOverride is
  // what makes a model-key override actually switch providers: passing
  // imageModelOverride='gemini-2.5-flash-image' with no imageBackendOverride
  // previously stayed on the default (grok) backend and silently rendered on
  // Grok — so any model-only A/B compared a model against itself.
  const modelBackend = imageModelOverride ? IMAGE_MODELS[imageModelOverride]?.backend : null;
  const imageBackend = imageBackendOverride || modelBackend || CONFIG_DEFAULTS?.imageBackend || 'gemini';
  if (verbose) {
    log.info(`🎨 [${logLabel}] Backend: ${imageBackend} (override=${imageBackendOverride || 'none'}, default=${CONFIG_DEFAULTS?.imageBackend || 'gemini'})`);
  } else {
    log.info(`🎨 [${logLabel}] Backend: ${imageBackend}`);
  }

  // ── Primary Runware (cheap FLUX Schnell) ──────────────────────────────────
  if (imageBackend === 'runware' && isRunwareConfigured()) {
    log.info(`🎨 [${logLabel}] Using Runware FLUX Schnell backend${verbose ? ' (cheap testing mode)' : ''}`);
    try {
      const referenceImages = extractDataImageUrls(characterPhotos);
      const result = await generateWithRunware(prompt, {
        model: RUNWARE_MODELS.FLUX_SCHNELL,
        width: 1024,
        height: 1024,
        steps: 4,
        referenceImages: referenceImages
      });
      if (onImageReady && result.imageData) {
        try { await onImageReady(result.imageData, result.modelId); }
        catch (callbackError) { log.error(`⚠️ [${logLabel}] onImageReady callback error:`, callbackError.message); }
      }
      return { provider: 'runware-primary', imageData: result.imageData, modelId: result.modelId, usage: result.usage, packedRefs: referenceImages, promptSent: prompt };
    } catch (runwareError) {
      log.error(verbose
        ? `❌ [RUNWARE] Generation failed, falling back to Gemini: ${runwareError.message}`
        : `❌ [${logLabel}] Runware failed, falling back to Gemini: ${runwareError.message}`);
      // Fall through to Gemini
    }
  }

  // ── Primary Grok Imagine ──────────────────────────────────────────────────
  if (imageBackend === 'grok' && isGrokConfigured()) {
    // Tier comes from the registry, never from a ternary or a hardcoded
    // constant: an explicit grok-backend override picks its own tier, anything
    // else falls back to Standard — announced, not silently.
    const grokTier = resolveGrokImageModel(imageModelOverride);
    if (imageModelOverride && !grokTier.isExplicit) {
      log.warn(`⚠️ [${logLabel}] Model override "${imageModelOverride}" is not a Grok tier — using ${grokTier.modelId}`);
    }
    const grokModel = grokTier.modelId;
    const grokAspect = outputAspect;
    log.info(`🎨 [${logLabel}] Using Grok Imagine backend (model: ${grokModel}${verbose ? `, type: ${evaluationType}, aspect: ${grokAspect}` : ''})`);

    // Truncate to Grok's prompt-length cap BEFORE the API call.
    const grokMaxPrompt = IMAGE_MODELS[grokTier.key]?.maxPromptLength || 7500;
    const grokPrompt = await shrinkPromptForModel(prompt, grokMaxPrompt, logLabel, grokModel, promptMeta);

    try {
      const refImages = await packReferences(
        { visualBibleGrid, landmarkPhotos, characterPhotos, previousImage, sceneBackground, textAreaMask, landmarkScene },
        { aspectRatio: grokAspect, pageLabel, padInputWithExtension: slot0IsScenePlate, ...(maxRefSlots ? { maxSlots: maxRefSlots } : {}), ...(vbColumnFraction ? { vbColumnFraction } : {}) }
      );

      let result;
      if (refImages.length > 0) {
        result = await editWithGrok(grokPrompt, refImages, { model: grokModel, aspectRatio: grokAspect, padInputWithExtension: slot0IsScenePlate, ...(maxRefSlots ? { maxRefs: maxRefSlots } : {}) });
      } else {
        result = await generateWithGrok(grokPrompt, { model: grokModel, aspectRatio: grokAspect });
      }

      if (onImageReady && result.imageData) {
        try { await onImageReady(result.imageData, result.modelId); }
        catch (callbackError) { log.error(`⚠️ [${logLabel}] onImageReady callback error:`, callbackError.message); }
      }

      return { provider: 'grok-primary', imageData: result.imageData, modelId: result.modelId, usage: result.usage, packedRefs: refImages, promptSent: grokPrompt };
    } catch (grokError) {
      log.error(verbose
        ? `❌ [GROK] Generation failed, falling back to Gemini: ${grokError.message}`
        : `❌ [${logLabel}] Grok failed, falling back to Gemini: ${grokError.message}`);
      // Fall through to Gemini
    }
  }

  // ── Build Gemini parts array (PROMPT FIRST, then images in order) ──────────
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Gemini API key not configured');
  }

  const hasSequentialImage = previousImage && previousImage.startsWith('data:image');
  const parts = [{ text: prompt }];
  let currentImageIndex = 1;

  // Sequential mode: cropped PREVIOUS scene image first (continuity anchor).
  if (hasSequentialImage) {
    const croppedImage = await cropImageForSequential(previousImage);
    const base64Data = r2Lib.stripDataUriPrefix(croppedImage);
    const mimeType = croppedImage.match(/^data:(image\/\w+);base64,/) ?
      croppedImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';
    parts.push({ text: `[Previous scene]:` });
    parts.push({ inline_data: { mime_type: mimeType, data: base64Data } });
    currentImageIndex++;
    log.debug(verbose
      ? `🖼️  [${logLabel}] Added cropped previous scene image for visual continuity (SEQUENTIAL MODE)`
      : `🖼️  [${logLabel}] Added cropped previous scene image (SEQUENTIAL MODE)`);
  }

  // Scene background reference (empty scene for style anchoring) — gen-only.
  if (includeSceneBackgroundPart && sceneBackground && sceneBackground.startsWith('data:image')) {
    const bgBase64 = r2Lib.stripDataUriPrefix(sceneBackground);
    const bgMime = sceneBackground.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    parts.push({ text: `[Background]:` });
    parts.push({ inline_data: { mime_type: bgMime, data: bgBase64 } });
    currentImageIndex++;
    log.debug(`🖼️ [${logLabel}] Added scene background reference`);
  }

  // Character photos as reference images (compressed + cached for token efficiency).
  if (characterPhotos && characterPhotos.length > 0) {
    let addedCount = 0;
    let skippedCount = 0;
    let cacheHits = 0;
    const characterNames = [];
    const apiImageHashes = [];  // verbose-only debug artifact

    for (const photoData of characterPhotos) {
      let photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
      if (photoUrl && typeof photoUrl === 'object') {
        if (Array.isArray(photoUrl)) {
          photoUrl = photoUrl[0];
        } else if (photoUrl.data) {
          photoUrl = photoUrl.data;
        } else if (photoUrl.imageData) {
          photoUrl = photoUrl.imageData;
        }
      }
      const characterName = typeof photoData === 'object' ? photoData?.name : null;
      const providedHash = typeof photoData === 'object' ? photoData?.photoHash : null;

      if (photoUrl && typeof photoUrl === 'string' && photoUrl.startsWith('data:image')) {
        const imageHash = hashImageData(photoUrl);
        let compressedBase64 = compressedRefCache.get(imageHash);
        if (compressedBase64) {
          cacheHits++;
        } else {
          const compressed = await compressImageToJPEG(photoUrl, 85, 768);
          compressedBase64 = r2Lib.stripDataUriPrefix(compressed);
          compressedRefCache.set(imageHash, compressedBase64);
        }

        if (verbose) {
          apiImageHashes.push({
            name: characterName || `photo_${addedCount + 1}`,
            hash: imageHash,
            matchesProvided: providedHash ? imageHash === providedHash : null
          });
        }

        // IMPORTANT: Do NOT use numbered format like [Image 1 - Name] as it triggers "character sheet" generation
        const labelName = characterName || `Character ${addedCount + 1}`;
        parts.push({ text: `[${labelName}]:` });
        if (characterName) {
          characterNames.push(characterName);
        }
        parts.push({ inline_data: { mime_type: 'image/jpeg', data: compressedBase64 } });
        currentImageIndex++;
        addedCount++;
      } else {
        skippedCount++;
        if (verbose) {
          const charLabel = characterName ? `"${characterName}"` : `#${addedCount + skippedCount}`;
          const preview = photoUrl
            ? (typeof photoUrl === 'string' ? photoUrl.substring(0, 30) : `[object: ${Object.keys(photoUrl).join(',')}]`)
            : 'null/undefined';
          log.warn(`[${logLabel}] Skipping character ${charLabel}: invalid photoUrl (${preview}...)`);
        }
      }
    }

    if (verbose && apiImageHashes.length > 0) {
      log.debug(`🔐 [${logLabel}] API image hashes:`, apiImageHashes.map(h => `${h.name}:${h.hash}`).join(', '));
    }
    if (characterNames.length > 0) {
      log.debug(`🖼️  [${logLabel}] Added ${addedCount} LABELED reference images: ${characterNames.join(', ')} (${cacheHits} cached)`);
    } else if (verbose) {
      log.debug(`🖼️  [${logLabel}] Added ${addedCount}/${characterPhotos.length} character reference images (${cacheHits} cached)`);
    }
    if (verbose && skippedCount > 0) {
      log.warn(`[${logLabel}] WARNING: ${skippedCount} photos were SKIPPED (not base64 data URLs)`);
    }
  }

  // Primary landmark reference photo only (1st landmark as separate image).
  // Never beside a plate: the plate already carries the landmark, painted and
  // people-free, and the raw photo next to it gets copied — people included.
  // Same rule packReferences applies on the Grok side.
  const hasScenePlate = typeof sceneBackground === 'string' && sceneBackground.startsWith('data:image');
  if (hasScenePlate && landmarkPhotos?.length > 0) {
    log.info(`🌍 [${logLabel}] Plate present — raw landmark photo "${landmarkPhotos[0]?.name || 'unknown'}" not attached`);
  }
  if (!hasScenePlate && landmarkScene && landmarkPhotos && landmarkPhotos.length > 0) {
    const primaryLandmark = landmarkPhotos[0];
    const candidates = [primaryLandmark.photoUrl, primaryLandmark.photoData].filter(s => typeof s === 'string' && s.length > 0);
    if (candidates.length > 0) {
      let buf = null;
      for (const source of candidates) {
        try { buf = await r2Lib.bytesFromAnyImage(source); if (buf) break; } catch { /* try next */ }
      }
      if (buf) {
        parts.push({ text: `[${primaryLandmark.name} (landmark)]:` });
        parts.push({ inline_data: { mime_type: 'image/jpeg', data: buf.toString('base64') } });
        currentImageIndex++;
        log.info(`🌍 [${logLabel}] Added primary landmark reference: ${primaryLandmark.name}`);
        if (verbose && landmarkPhotos.length > 1) {
          log.debug(`🌍 [${logLabel}] ${landmarkPhotos.length - 1} secondary landmark(s) excluded (should be in VB grid)`);
        }
      } else {
        log.warn(verbose
          ? `⚠️ [${logLabel}] Landmark "${primaryLandmark.name}": failed to load bytes — skipping`
          : `⚠️ [${logLabel}] Landmark "${primaryLandmark.name}": failed to load bytes from any source — skipping`);
      }
    } else {
      log.warn(verbose
        ? `⚠️ [${logLabel}] Landmark "${primaryLandmark.name}" has no photoData — skipping`
        : `⚠️ [${logLabel}] Landmark "${primaryLandmark.name}" has no source — skipping`);
    }
  }

  // Visual Bible reference grid (secondary chars, animals, artifacts, vehicles, 2nd+ landmarks).
  if (visualBibleGrid) {
    parts.push({ text: `[Reference Grid (objects, secondary characters, locations)]:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: visualBibleGrid.toString('base64') } });
    currentImageIndex++;
    log.info(verbose
      ? `🔲 [${logLabel}] Added Visual Bible reference grid (${Math.round(visualBibleGrid.length / 1024)}KB)`
      : `🔲 [${logLabel}] Added Visual Bible reference grid`);
  }

  if (verbose) {
    log.debug(`🔍 [${logLabel}] Parts array structure: ${parts.map((p, i) =>
      p.text ? `[${i}] text(${p.text.length}ch)` :
      p.inline_data ? `[${i}] image(${p.inline_data.mime_type})` : `[${i}] unknown`
    ).join(', ')}`);
  }

  // ── Resolve model id + truncate to its cap ────────────────────────────────
  let modelId = imageModelOverride || defaultModel;
  if (verbose && imageModelOverride) {
    log.debug(`🔧 [${logLabel}] Using model override: ${modelId}`);
  }

  const modelConfig = IMAGE_MODELS[modelId];
  const maxPromptLength = modelConfig?.maxPromptLength || 30000;
  const effectivePrompt = await shrinkPromptForModel(prompt, maxPromptLength, logLabel, verbose ? modelId : null, promptMeta);
  if (effectivePrompt !== prompt) {
    parts[0] = { text: effectivePrompt };
  }

  // ── Model-routed Runware (model config says backend='runware') ────────────
  if (modelConfig?.backend === 'runware' && isRunwareConfigured()) {
    log.info(verbose
      ? `🎨 [${logLabel}] Model ${modelId} uses Runware backend - routing to Runware`
      : `🎨 [${logLabel}] Model ${modelId} uses Runware backend`);
    try {
      const runwareModel = modelId === 'flux-dev' ? RUNWARE_MODELS.FLUX_DEV : RUNWARE_MODELS.FLUX_SCHNELL;
      const referenceImages = extractDataImageUrls(characterPhotos);
      const result = await generateWithRunware(effectivePrompt, {
        model: runwareModel,
        width: 1024,
        height: 1024,
        steps: modelId === 'flux-dev' ? 30 : 4,
        referenceImages: referenceImages
      });
      if (onImageReady && result.imageData) {
        try { await onImageReady(result.imageData, result.modelId); }
        catch (callbackError) { log.error(`⚠️ [${logLabel}] onImageReady callback error:`, callbackError.message); }
      }
      return { provider: 'runware-routed', imageData: result.imageData, modelId: result.modelId, usage: result.usage, packedRefs: referenceImages, promptSent: effectivePrompt };
    } catch (runwareError) {
      log.error(`❌ [${logLabel}] Runware generation failed:`, runwareError.message);
      throw runwareError;
    }
  }

  // ── Model-routed Grok (model config says backend='grok') ──────────────────
  if (modelConfig?.backend === 'grok' && isGrokConfigured()) {
    log.info(verbose
      ? `🎨 [${logLabel}] Model ${modelId} uses Grok backend - routing to Grok`
      : `🎨 [${logLabel}] Model ${modelId} uses Grok backend`);
    try {
      // Resolve the REAL model id from the registry — same resolver the
      // primary-Grok branch above uses, so the two routes cannot drift.
      const grokModel = resolveGrokImageModel(modelId).modelId;
      const grokAspect = outputAspect;

      // Avatars: each reference (face, body, style) as its own slot; scenes: normal packing.
      let refImages;
      if (avatarMode && characterPhotos?.length > 0) {
        refImages = extractDataImageUrls(characterPhotos.slice(0, 3));
        log.info(`🎨 [GROK] Avatar mode: ${refImages.length} reference images as separate slots`);
      } else {
        refImages = await packReferences(
          { visualBibleGrid, landmarkPhotos, characterPhotos, previousImage, sceneBackground, landmarkScene },
          { aspectRatio: grokAspect, pageLabel, padInputWithExtension: slot0IsScenePlate }
        );
      }

      let result;
      if (refImages.length > 0) {
        result = await editWithGrok(effectivePrompt, refImages, { model: grokModel, aspectRatio: grokAspect, padInputWithExtension: slot0IsScenePlate });
      } else {
        result = await generateWithGrok(effectivePrompt, { model: grokModel, aspectRatio: grokAspect });
      }

      if (onImageReady && result.imageData) {
        try { await onImageReady(result.imageData, result.modelId); } catch (e) { /* ignore */ }
      }

      return { provider: 'grok-routed', imageData: result.imageData, modelId: result.modelId, usage: result.usage, packedRefs: refImages, promptSent: effectivePrompt };
    } catch (grokError) {
      log.error(`❌ [${logLabel}] Grok generation failed (model-routed), falling back to Gemini: ${grokError.message}`);
      // Fall through to Gemini below
    }
  }

  // If modelId points at a non-Gemini backend (Grok/Runware) we reached here
  // via the fallback path — swap to a known-good Gemini image model so the
  // URL the wrapper builds is valid.
  if (IMAGE_MODELS[modelId]?.backend && IMAGE_MODELS[modelId].backend !== 'gemini') {
    const originalModelId = modelId;
    modelId = 'gemini-2.5-flash-image';
    log.warn(`🔄 [${logLabel}] Fallback: swapped model ${originalModelId} → ${modelId} for Gemini API call`);
  }

  // Gemini fallback sentinel — parts built, model resolved + swapped, prompt
  // truncated. The wrapper runs its own terminal Gemini fetch (they differ).
  return { provider: 'gemini', parts, modelId, effectivePrompt };
}

/**
 * Call Gemini API for image generation
 * @param {string} prompt - The image generation prompt
 * @param {string[]} characterPhotos - Character reference photos
 * @param {string|null} previousImage - Previous image for sequential mode
 * @param {string} evaluationType - 'scene' or 'cover'
 * @param {Function|null} onImageReady - Callback when image is ready
 * @param {string|null} imageModelOverride - Override image model (e.g., 'gemini-2.5-flash-image' or 'gemini-3-pro-image-preview')
 * @param {string|null} qualityModelOverride - Override quality evaluation model
 * @param {string|null} imageBackendOverride - Override image backend ('gemini' or 'runware')
 * @param {Array<{name: string, photoData: string}>} landmarkPhotos - Landmark reference photos (only 1st used as separate image)
 * @param {number} sceneCharacterCount - Number of characters in scene (for determining if >3)
 * @param {Buffer|null} visualBibleGrid - Combined grid image of VB elements and secondary landmarks
 * @returns {Promise<{imageData, score, reasoning, modelId, ...}>}
 */
async function callGeminiAPIForImage(prompt, characterPhotos = [], previousImage = null, evaluationType = 'scene', onImageReady = null, imageModelOverride = null, qualityModelOverride = null, pageContext = '', imageBackendOverride = null, landmarkPhotos = [], sceneCharacterCount = 0, visualBibleGrid = null, storyText = null, sceneHint = null, sceneBackground = null, aspectRatioOverride = null, sceneCharacters = null) {
  prompt = guardPromptString(prompt, 'images.callGeminiAPIForImage');
  // Extract page number from pageContext (e.g., "PAGE 5" or "PAGE 5 (consistency fix)")
  const pageMatch = pageContext.match(/PAGE\s*(\d+)/i);
  const pageNumber = pageMatch ? parseInt(pageMatch[1], 10) : null;

  // Check cache first (include previousImage presence and page number in cache key)
  const cacheKey = generateImageCacheKey(prompt, characterPhotos, previousImage ? 'seq' : null, pageNumber);

  if (imageCache.has(cacheKey)) {
    log.debug(`💾 [IMAGE CACHE] HIT (${imageCache.size} cached)`);
    const cachedResult = imageCache.get(cacheKey);
    // Call onImageReady for cache hits too (for progressive display)
    if (onImageReady && cachedResult.imageData) {
      try {
        await onImageReady(cachedResult.imageData, cachedResult.modelId);
      } catch (callbackError) {
        log.error('⚠️ [IMAGE CACHE] onImageReady callback error:', callbackError.message);
      }
    }
    return cachedResult;
  }

  log.debug(`🆕 [IMAGE CACHE] MISS - key: ${cacheKey.substring(0, 16)}...`);

  // Aspect ratio: explicit override wins, otherwise read from MODEL_DEFAULTS
  // (pageAspect / coverAspect / avatarAspect — all configured in one place).
  const outputAspect = resolveOutputAspect(evaluationType, aspectRatioOverride);

  // Shared provider-dispatch ladder (Runware/Grok/Gemini selection + reference
  // packing + truncation + aspect + onImageReady). See _dispatchImageGeneration.
  const raw = await _dispatchImageGeneration(prompt, characterPhotos, {
    logLabel: 'IMAGE GEN',
    verbose: true,
    previousImage,
    imageModelOverride,
    imageBackendOverride,
    landmarkPhotos,
    visualBibleGrid,
    sceneBackground,
    textAreaMask: null,
    onImageReady,
    outputAspect,
    evaluationType,
    usePadExtension: false,
    avatarMode: evaluationType === 'avatar',
    pageLabel: pageNumber != null ? String(pageNumber) : pageContext,
    defaultModel: evaluationType === 'cover' ? MODEL_DEFAULTS.coverImage : MODEL_DEFAULTS.pageImage,
    includeSceneBackgroundPart: false,
  });

  // Same 9-arg quality eval every non-avatar branch ran inline before.
  // IMAGE_PROMPT = the string the provider actually received. `prompt` is the
  // PRE-shrink text; over the model's cap _dispatchImageGeneration compresses
  // it and returns the sent string as `raw.promptSent`. See
  // sceneMetadata.resolveEvalImagePrompt for why judging the pre-shrink text
  // manufactures "missing X" findings against instructions never given.
  const runEval = () => evaluateImageQuality(
    raw.imageData, resolveEvalImagePrompt({ promptSent: raw.promptSent, originalPrompt: prompt }),
    characterPhotos, evaluationType,
    qualityModelOverride, pageContext, storyText, sceneHint, sceneCharacters
  );

  // ── Primary Runware branch: eval + big shape, cache ───────────────────────
  if (raw.provider === 'runware-primary') {
    const qualityResult = await runEval();
    if (!qualityResult) {
      log.warn(`⚠️  [IMAGE GEN] Quality eval unavailable for ${pageContext || 'image'} (Runware) — returning image with score=null so pipeline can re-evaluate next round`);
    }
    const finalResult = {
      imageData: raw.imageData,
      modelId: raw.modelId,
      score: qualityResult?.score ?? null,
      // Distinguish "no opinion" from "eval failed". Null score + evaluated:false
      // tells findBadPages to redo the page instead of silently shipping it
      // because the eval call timed out / blew up.
      evaluated: !!qualityResult,
      evalError: qualityResult ? null : 'evaluator returned no result',
      reasoning: qualityResult?.reasoning ?? null,
      detectedProblems: qualityResult?.detectedProblems || [],
      figures: qualityResult?.figures || [],
      matches: qualityResult?.matches || [],
      objectMatches: qualityResult?.object_matches || [],
      fixTargets: qualityResult?.fixTargets || [],
      fixableIssues: qualityResult?.fixableIssues || [],
      semanticResult: qualityResult?.semanticResult || null,
      semanticScore: qualityResult?.semanticScore ?? null,
      ...carryEvalEvidence(qualityResult),
      issuesSummary: qualityResult?.issuesSummary || null,
      verdict: qualityResult?.verdict || null,
      usage: raw.usage
    };
    imageCache.set(cacheKey, finalResult);
    log.debug(`💾 [IMAGE CACHE] Stored (${imageCache.size}/${IMAGE_CACHE_MAX_SIZE})`);
    return finalResult;
  }

  // ── Primary Grok branch: avatar skip OR eval + big shape, cache ───────────
  if (raw.provider === 'grok-primary') {
    // Skip quality evaluation for avatar conversions (just style transfer)
    if (evaluationType === 'avatar') {
      log.debug(`⏭️ [QUALITY] Skipping quality evaluation for Grok avatar conversion`);
      const finalResult = {
        imageData: raw.imageData,
        modelId: raw.modelId,
        score: null,
        reasoning: null,
        imageUsage: raw.usage,
        usage: raw.usage
      };
      imageCache.set(cacheKey, finalResult);
      return finalResult;
    }

    const qualityResult = await runEval();
    if (!qualityResult) {
      log.warn(`⚠️  [IMAGE GEN] Quality eval unavailable for ${pageContext || 'image'} (Grok backend) — returning image with score=null so pipeline can re-evaluate next round`);
    }
    const finalResult = {
      imageData: raw.imageData,
      modelId: raw.modelId,
      score: qualityResult?.score ?? null,
      evaluated: !!qualityResult,
      evalError: qualityResult ? null : 'evaluator returned no result',
      reasoning: qualityResult?.reasoning ?? null,
      detectedProblems: qualityResult?.detectedProblems || [],
      figures: qualityResult?.figures || [],
      matches: qualityResult?.matches || [],
      objectMatches: qualityResult?.object_matches || [],
      fixTargets: qualityResult?.fixTargets || [],
      fixableIssues: qualityResult?.fixableIssues || [],
      semanticResult: qualityResult?.semanticResult || null,
      semanticScore: qualityResult?.semanticScore ?? null,
      ...carryEvalEvidence(qualityResult),
      issuesSummary: qualityResult?.issuesSummary || null,
      verdict: qualityResult?.verdict || null,
      // `imageUsage` is the field provider-style usage trackers read.
      // The legacy `usage:` field stays for any direct callers of this function.
      imageUsage: raw.usage,
      qualityUsage: qualityResult?.usage ?? null,
      qualityModelId: qualityResult?.qualityModelId ?? null,
      usage: raw.usage,
      grokRefImages: raw.packedRefs.length > 0 ? raw.packedRefs : undefined,
      // Prompt actually sent (may be truncated to Grok's max).
      prompt: raw.promptSent,
    };
    imageCache.set(cacheKey, finalResult);
    log.debug(`💾 [IMAGE CACHE] Stored (${imageCache.size}/${IMAGE_CACHE_MAX_SIZE})`);
    return finalResult;
  }

  // ── Model-routed Runware branch: eval + shape (no cache, matches original) ─
  if (raw.provider === 'runware-routed') {
    const qualityResult = await runEval();
    if (!qualityResult) {
      log.warn(`⚠️  [IMAGE GEN] Quality eval unavailable for ${pageContext || 'image'} (Runware in generateImageOnly) — returning image with score=null so pipeline can re-evaluate next round`);
    }
    return {
      imageData: raw.imageData,
      modelId: raw.modelId,
      score: qualityResult?.score ?? null,
      numericScore: qualityResult?.numericScore ?? null,
      reasoning: qualityResult?.reasoning ?? null,
      verdict: qualityResult?.verdict ?? null,
      fixTargets: qualityResult?.fixTargets ?? [],
      fixableIssues: qualityResult?.fixableIssues || [],
      semanticResult: qualityResult?.semanticResult || null,
      semanticScore: qualityResult?.semanticScore ?? null,
      ...carryEvalEvidence(qualityResult),
      issuesSummary: qualityResult?.issuesSummary || null,
      qualityModelId: qualityResult?.qualityModelId ?? null,
      imageUsage: raw.usage,
      qualityUsage: qualityResult?.usage ?? null,
      // Reconstruction record (see Gemini/Grok branches).
      prompt: raw.promptSent,
      grokRefImages: raw.packedRefs?.length > 0 ? raw.packedRefs : undefined
    };
  }

  // ── Model-routed Grok branch: eval + shape (no cache, matches original) ────
  if (raw.provider === 'grok-routed') {
    const qualityResult = await runEval();
    if (!qualityResult) {
      log.warn(`⚠️  [IMAGE GEN] Quality eval unavailable for ${pageContext || 'image'} (Grok in generateImageOnly) — returning image with score=null so pipeline can re-evaluate next round`);
    }
    return {
      imageData: raw.imageData,
      modelId: raw.modelId,
      score: qualityResult?.score ?? null,
      numericScore: qualityResult?.numericScore ?? null,
      reasoning: qualityResult?.reasoning ?? null,
      verdict: qualityResult?.verdict ?? null,
      fixTargets: qualityResult?.fixTargets ?? [],
      fixableIssues: qualityResult?.fixableIssues || [],
      semanticResult: qualityResult?.semanticResult || null,
      semanticScore: qualityResult?.semanticScore ?? null,
      ...carryEvalEvidence(qualityResult),
      issuesSummary: qualityResult?.issuesSummary || null,
      qualityModelId: qualityResult?.qualityModelId ?? null,
      imageUsage: raw.usage,
      qualityUsage: qualityResult?.usage ?? null,
      // Exact packed references sent to Grok (for dev-mode "Sent to Grok" display).
      grokRefImages: raw.packedRefs.length > 0 ? raw.packedRefs : undefined,
      // Prompt actually sent (may be truncated to the model's max).
      prompt: raw.promptSent,
    };
  }

  // ── Gemini fallback: terminal single-shot fetch + eval (eval-path only) ────
  // The core already built `parts`, resolved + swapped `modelId`, and truncated
  // the prompt. This block reproduces the eval path's ORIGINAL Gemini generator:
  // one withRetry fetch, recordImageApiUsage, rich refusal-error extraction, and
  // the avatar-skip early return — deliberately NOT shared with generateImageOnly's
  // sanitization-retry-loop Gemini generator (they are different generators).
  const { parts, modelId, effectivePrompt } = raw;
  const apiKey = process.env.GEMINI_API_KEY;

  const systemInstruction = getImageSystemInstruction();
  const geminiAspect = outputAspect;
  const requestBody = {
    ...(systemInstruction && { systemInstruction }),
    contents: [{
      parts: parts
    }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      ...geminiSampling(modelId),
      ...(modelSupportsThinking(modelId) && { thinkingConfig: { includeThoughts: true } }),
      imageConfig: {
        aspectRatio: geminiAspect
      }
    }
  };

  log.debug(`🖼️  [IMAGE GEN] Calling Gemini API with prompt (${prompt.length} chars), scene: ${prompt.substring(0, 80).replace(/\n/g, ' ')}...`);
  log.debug(`🖼️  [IMAGE GEN] Model: ${modelId}, Aspect Ratio: ${geminiAspect}, Sampling: ${JSON.stringify(geminiSampling(modelId))}, systemInstruction: ${!!systemInstruction}`);

  const data = await withRetry(async () => {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    log.debug('🖼️  [IMAGE GEN] Response status:', response.status, response.statusText);

    if (!response.ok) {
      const error = await response.text();
      log.error('❌ [IMAGE GEN] Gemini API error response:', error);
      const err = new Error(`Gemini API error (${response.status}): ${error}`);
      err.status = response.status;
      throw err;
    }

    return response.json();
  }, { maxRetries: 2, baseDelay: 2000 });

  // Extract token usage from response (including thinking tokens for Gemini 2.5)
  const imageUsage = {
    input_tokens: data.usageMetadata?.promptTokenCount || 0,
    output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
    thinking_tokens: data.usageMetadata?.thoughtsTokenCount || 0
  };
  if (imageUsage.input_tokens > 0 || imageUsage.output_tokens > 0) {
    const thinkingInfo = imageUsage.thinking_tokens > 0 ? `, thinking: ${imageUsage.thinking_tokens.toLocaleString()}` : '';
    log.debug(`📊 [IMAGE GEN] Token usage - input: ${imageUsage.input_tokens.toLocaleString()}, output: ${imageUsage.output_tokens.toLocaleString()}${thinkingInfo}`);
  }
  // Structured cost log so analyze-story-log.js can attribute Nano Banana spend.
  recordImageApiUsage(modelId, evaluationType, imageUsage);

  if (!data.candidates || data.candidates.length === 0) {
    log.error('❌ [IMAGE GEN] No candidates in response');
    throw new Error('No image generated - no candidates in response');
  }

  // Extract image data
  const candidate = data.candidates[0];

  // Extract thinking text from response (Gemini 3 Pro / 2.5 Flash thinking mode)
  const thinkingText = extractThinkingFromParts(candidate.content?.parts, 'IMAGE GEN');

  if (candidate.content && candidate.content.parts) {
    for (const part of candidate.content.parts) {
      // Check both camelCase (inlineData) and snake_case (inline_data) - Gemini API may vary
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData && inlineData.data) {
        const imageDataSize = inlineData.data.length;
        const imageSizeKB = (imageDataSize / 1024).toFixed(2);
        console.log(`✅ [IMAGE GEN] Successfully extracted image data (${imageSizeKB} KB base64)`);
        const pngImageData = `data:image/png;base64,${inlineData.data}`;

        // Compress PNG to JPEG
        log.debug('🗜️  [COMPRESSION] Compressing image to JPEG...');
        const compressedImageData = await compressImageToJPEG(pngImageData);

        // Call onImageReady callback immediately (before quality eval) for progressive display
        if (onImageReady) {
          try {
            await onImageReady(compressedImageData, modelId);
            log.debug('📤 [IMAGE GEN] Image sent for immediate display (quality eval pending)');
          } catch (callbackError) {
            log.error('⚠️ [IMAGE GEN] onImageReady callback error:', callbackError.message);
          }
        }

        // Skip quality evaluation for avatar conversions (just style transfer, no scene composition)
        if (evaluationType === 'avatar') {
          log.debug(`⏭️ [QUALITY] Skipping quality evaluation for avatar conversion`);
          const result = {
            imageData: compressedImageData,
            score: null,
            reasoning: null,
            modelId,
            thinkingText,
            imageUsage: imageUsage
          };
          imageCache.set(cacheKey, result);
          return result;
        }

        // Evaluate image quality with prompt and reference images
        log.debug(`📊 [EVAL] Evaluating image quality (${evaluationType})...${qualityModelOverride ? ` [model: ${qualityModelOverride}]` : ''}`);
        // Same rule as the runEval above: judge against what Gemini received.
        // parts[0].text is the post-shrink text (it is also what this branch
        // stamps as the result's `prompt`, a few lines down).
        const qualityResult = await evaluateImageQuality(compressedImageData, resolveEvalImagePrompt({ promptSent: parts[0]?.text, originalPrompt: prompt }), characterPhotos, evaluationType, qualityModelOverride, pageContext, storyText, sceneHint, sceneCharacters);

        // Extract score, reasoning, and text error info from quality result
        const score = qualityResult ? qualityResult.score : null;
        const reasoning = qualityResult ? qualityResult.reasoning : null;
        const textIssue = qualityResult ? qualityResult.textIssue : null;
        const textErrorOnly = qualityResult ? qualityResult.textErrorOnly : false;
        const expectedText = qualityResult ? qualityResult.expectedText : null;
        const actualText = qualityResult ? qualityResult.actualText : null;
        const qualityUsage = qualityResult ? qualityResult.usage : null;
        const qualityModelId = qualityResult ? qualityResult.modelId : null;
        const fixTargets = qualityResult ? qualityResult.fixTargets : [];
        const fixableIssues = qualityResult ? qualityResult.fixableIssues : [];
        const figures = qualityResult ? qualityResult.figures : [];
        const matches = qualityResult ? qualityResult.matches : [];
        const objectMatches = qualityResult ? qualityResult.object_matches : [];

        // Store in cache (include text error info for covers)
        const result = {
          imageData: compressedImageData,
          score,
          reasoning,
          textIssue,
          textErrorOnly,
          expectedText,
          actualText,
          fixTargets, // Bounding boxes for auto-repair (from evaluation)
          fixableIssues, // New format without bboxes (for two-stage detection)
          figures, // Figure detection results from evaluation
          matches, // Character-to-figure matches from evaluation
          objectMatches, // Object/animal/landmark matches from evaluation
          semanticResult: qualityResult?.semanticResult || null,
          semanticScore: qualityResult?.semanticScore ?? null,
          ...carryEvalEvidence(qualityResult),
          issuesSummary: qualityResult?.issuesSummary || null,
          verdict: qualityResult?.verdict || null,
          modelId,  // Include which model was used for image generation
          qualityModelId,  // Include which model was used for quality evaluation
          thinkingText, // Gemini thinking/reasoning text (if available)
          imageUsage: imageUsage,  // Token usage for image generation
          qualityUsage: qualityUsage,  // Token usage for quality evaluation
          // Reconstruction record: prompt + reference images actually sent in
          // this call. parts[0] holds the exact sent text (post-truncation when
          // a model cap applied); grokRefImages is the historical field name for
          // "refs sent to the image model".
          prompt: parts[0]?.text || prompt,
          grokRefImages: parts
            .filter(p => p.inline_data)
            .map(p => `data:${p.inline_data.mime_type};base64,${p.inline_data.data}`)
        };
        imageCache.set(cacheKey, result);
        log.verbose('💾 [IMAGE CACHE] Stored in cache. Total cached:', imageCache.size, 'images');

        return result;
      }
    }
  } else {
    const reason = candidate.finishReason || 'unknown';
    const message = candidate.finishMessage || 'no message';
    log.error(`❌ [IMAGE GEN] Image blocked: reason=${reason}, message=${message}`);
    log.error(`❌ [IMAGE GEN] Failed prompt (first 1000 chars): "${prompt.substring(0, 1000)}..."`);
    throw new Error(`Image blocked by API: reason=${reason}, message=${message}`);
  }

  // No image found - log what Gemini actually returned (likely a refusal message)
  const textParts = candidate.content?.parts?.filter(p => p.text) || [];
  if (textParts.length > 0) {
    const refusalMessage = textParts.map(p => p.text).join(' ').substring(0, 500);
    log.error(`❌ [IMAGE GEN] No image data - Gemini returned text instead: "${refusalMessage}"`);
    log.error(`❌ [IMAGE GEN] Failed prompt (first 1000 chars): "${prompt.substring(0, 1000)}..."`);
    throw new Error(`Image generation refused: ${refusalMessage.substring(0, 200)}`);
  }

  log.error('❌ [IMAGE GEN] No image data found in any part');
  log.error(`❌ [IMAGE GEN] Failed prompt (first 1000 chars): "${prompt.substring(0, 1000)}..."`);
  throw new Error('No image data in response - check logs for API response structure');
}

/**
 * Generate image without quality evaluation
 * Used by the separated evaluation pipeline to generate all images first, then evaluate in batch
 * This is a streamlined version of callGeminiAPIForImage that skips evaluation
 *
 * @param {string} prompt - The image generation prompt
 * @param {Array} characterPhotos - Array of character photos (URLs or {name, photoUrl} objects)
 * @param {Object} options - Generation options
 * @param {string|null} options.previousImage - Previous image for sequential mode
 * @param {string|null} options.imageModelOverride - Model override for image generation
 * @param {string|null} options.imageBackendOverride - Backend override ('gemini' or 'runware')
 * @param {Array} options.landmarkPhotos - Landmark reference photos
 * @param {Buffer|null} options.visualBibleGrid - Visual Bible grid buffer
 * @param {number|null} options.pageNumber - Page number for cache key
 * @param {Function|null} options.onImageReady - Callback for progressive display
 * @returns {Promise<{imageData: string, modelId: string, usage: Object}>}
 */
async function generateImageOnly(prompt, characterPhotos = [], options = {}) {
  prompt = guardPromptString(prompt, 'images.generateImageOnly');
  const {
    previousImage = null,
    imageModelOverride = null,
    imageBackendOverride = null,
    landmarkPhotos = [],
    visualBibleGrid = null,
    pageNumber = null,
    onImageReady = null,
    skipCache = false,
    artStyle = 'watercolor',
    sceneBackground = null,
    // Text area mask — black/white PNG telling the model where to keep calm
    // space for text overlay. White region = calm/light, black = full detail.
    // Used primarily by empty scene generation.
    textAreaMask = null,
    // Output aspect ratio — defaults to MODEL_DEFAULTS.pageAspect (A4 portrait)
    // so callers that forget to pass one still get the configured page aspect.
    // Callers can override: avatars pass '9:16', covers pass MODEL_DEFAULTS.coverAspect.
    // Flows through to Grok and Gemini image configs.
    aspectRatio = CONFIG_DEFAULTS.pageAspect,
    // Test Lab prompt-capture label (promptCapture.js). When set, the prompt is
    // recorded at this shared chokepoint so every provider route is covered by
    // one line (e.g. 'image_cover', 'image_scene'). No-op outside an experiment.
    captureLabel = null,
    // Post-gen crop of a stray uniform frame the model paints despite the D-01
    // prompt ban (a blue/black keyline framing the art). Page scenes want it;
    // covers (title paint) and avatars opt out by passing stripBorder: false.
    stripBorder = true,
    // Test Lab only: raise the Grok reference-slot budget above the production
    // default of 3 (xAI's edit cap is 5, re-verified 2026-09-02).
    maxRefSlots = null,
    // Test Lab only: widen the VB element column (cell-geometry experiment).
    vbColumnFraction = null,
    // Role of a raw landmark photo when no plate is sent ('plate' | 'castless'
    // | null) — server/lib/landmarkScene.js. Checked BEFORE the cache, so a
    // cached render can never stand in for a refused one.
    landmarkScene = null,
  } = options;
  assertLandmarkScene({ landmarkPhotos, sceneBackground, landmarkScene, label: `IMAGE GEN-ONLY P${pageNumber ?? '?'}` });

  if (captureLabel) {
    require('./promptCapture').recordPrompt(captureLabel, imageModelOverride, prompt, { kind: 'image' });
  }

  // Check cache first (include previousImage presence and page number in cache key)
  const cacheKey = generateImageCacheKey(prompt, characterPhotos, previousImage ? 'seq' : null, pageNumber, sceneBackground ? 'bg' : null);

  // For generateImageOnly, we use a separate cache namespace to avoid conflicts with evaluated images
  const genOnlyCacheKey = `genonly_${cacheKey}`;

  if (!skipCache && imageCache.has(genOnlyCacheKey)) {
    log.debug(`💾 [IMAGE GEN-ONLY] Cache HIT (${imageCache.size} cached)`);
    const cachedResult = imageCache.get(genOnlyCacheKey);
    if (onImageReady && cachedResult.imageData) {
      try {
        await onImageReady(cachedResult.imageData, cachedResult.modelId);
      } catch (callbackError) {
        log.error('⚠️ [IMAGE GEN-ONLY] onImageReady callback error:', callbackError.message);
      }
    }
    return cachedResult;
  }

  log.debug(`🆕 [IMAGE GEN-ONLY] Cache MISS - key: ${genOnlyCacheKey.substring(0, 24)}...`);

  // Over-cap prompts are LLM-compressed before they are sent. `shrinkMeta`
  // collects the COMPRESSED SCENE BLOCK so it can be stamped onto the result
  // (and from there onto the page record) — the batch image eval scores the
  // render against that description, not the pre-shrink one. Empty on the
  // overwhelmingly common under-cap path, and the field is then omitted
  // entirely, so unshrunk pages carry exactly what they carried before.
  const shrinkMeta = {};
  const sceneStamp = () => (shrinkMeta.compressedScene ? { compressedScene: shrinkMeta.compressedScene } : {});

  // Shared provider-dispatch ladder (Runware/Grok/Gemini selection + reference
  // packing + truncation + aspect + onImageReady). See _dispatchImageGeneration.
  const raw = await _dispatchImageGeneration(prompt, characterPhotos, {
    promptMeta: shrinkMeta,
    logLabel: 'IMAGE GEN-ONLY',
    verbose: false,
    previousImage,
    imageModelOverride,
    imageBackendOverride,
    landmarkPhotos,
    visualBibleGrid,
    sceneBackground,
    textAreaMask,
    landmarkScene,
    onImageReady,
    outputAspect: aspectRatio,
    evaluationType: null,
    usePadExtension: true,
    avatarMode: false,
    pageLabel: pageNumber != null ? String(pageNumber) : '',
    defaultModel: MODEL_DEFAULTS.pageImage,
    includeSceneBackgroundPart: true,
    maxRefSlots,
    vbColumnFraction,
  });

  // Strip a stray uniform frame the model painted despite the D-01 prompt ban
  // (a blue/black keyline framing the art — observed ~20% of pages). Deterministic
  // + conservative: server/lib/borderCrop.js only fires for a genuine four-sided
  // thin uniform frame. Covers the Grok/Runware branches (raw.imageData is set
  // here); the rare Gemini fallback below is not yet covered.
  if (stripBorder && raw?.imageData) {
    try {
      const { stripUniformBorder } = require('./borderCrop');
      const cropRes = await stripUniformBorder(Buffer.from(r2Lib.stripDataUriPrefix(raw.imageData), 'base64'));
      if (cropRes.cropped) {
        raw.imageData = `data:image/jpeg;base64,${cropRes.buffer.toString('base64')}`;
        log.info(`✂️ [IMAGE GEN-ONLY]${pageNumber != null ? ` p${pageNumber}` : ''} stripped uniform frame ${JSON.stringify(cropRes.frameColor)} (sides ${JSON.stringify(cropRes.sides)})`);
      }
    } catch (e) {
      log.warn(`⚠️ [IMAGE GEN-ONLY] border strip failed (keeping original): ${e.message}`);
    }
  }

  // ── Shape raw result per provider (gen-only: no eval, minimal shape) + cache ─
  if (raw.provider === 'runware-primary') {
    const finalResult = {
      imageData: raw.imageData,
      modelId: raw.modelId,
      usage: raw.usage,
      ...sceneStamp()
    };
    if (!skipCache) imageCache.set(genOnlyCacheKey, finalResult);
    return finalResult;
  }

  if (raw.provider === 'grok-primary') {
    const finalResult = {
      imageData: raw.imageData,
      // The PROMPT ACTUALLY SENT, like every sibling branch in this function
      // (runware-routed, grok-routed, the Gemini fallback). This one alone
      // stamped the pre-shrink text, and grok-primary is the default page
      // path — which is why staging job_1789301291267_ueh8h145m stores a
      // 7,939-char prompt for a model whose cap is 7,900. Everything
      // downstream that reads this field (the batch eval's ORIGINAL_PROMPT
      // fallback, coverIterate's eval, the dev-mode "sent to Grok" panel)
      // was therefore shown a string the model never received.
      prompt: raw.promptSent,
      modelId: raw.modelId,
      usage: raw.usage,
      grokRefImages: raw.packedRefs.length > 0 ? raw.packedRefs : undefined,
      ...sceneStamp()
    };
    if (!skipCache) imageCache.set(genOnlyCacheKey, finalResult);
    return finalResult;
  }

  if (raw.provider === 'runware-routed') {
    const finalResult = {
      imageData: raw.imageData,
      prompt: raw.promptSent,
      modelId: raw.modelId,
      usage: raw.usage,
      // Reconstruction record — refs were built above but never stamped.
      grokRefImages: raw.packedRefs.length > 0 ? raw.packedRefs : undefined,
      ...sceneStamp()
    };
    if (!skipCache) imageCache.set(genOnlyCacheKey, finalResult);
    return finalResult;
  }

  if (raw.provider === 'grok-routed') {
    const finalResult = {
      imageData: raw.imageData,
      prompt: raw.promptSent,
      modelId: raw.modelId,
      usage: raw.usage,
      grokRefImages: raw.packedRefs.length > 0 ? raw.packedRefs : undefined,
      ...sceneStamp()
    };
    if (!skipCache) imageCache.set(genOnlyCacheKey, finalResult);
    return finalResult;
  }

  // ── Gemini fallback: terminal fetch WITH the 3-level safety sanitization loop ─
  // The core already built `parts`, resolved + swapped `modelId`, and truncated
  // the prompt into `effectivePrompt`. This block is generateImageOnly's ORIGINAL
  // Gemini generator — deliberately NOT shared with callGeminiAPIForImage's
  // single-shot generator (that one records usage + extracts refusal text; this
  // one runs a sanitization retry loop instead).
  const { parts, modelId, effectivePrompt } = raw;
  const apiKey = process.env.GEMINI_API_KEY;

  const systemInstruction = getImageSystemInstruction();
  const requestBody = {
    ...(systemInstruction && { systemInstruction }),
    contents: [{
      parts: parts
    }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      ...geminiSampling(modelId),
      ...(modelSupportsThinking(modelId) && { thinkingConfig: { includeThoughts: true } }),
      imageConfig: {
        aspectRatio
      }
    }
  };

  log.debug(`🖼️  [IMAGE GEN-ONLY] Calling Gemini API with prompt (${prompt.length} chars), model: ${modelId}, sampling: ${JSON.stringify(geminiSampling(modelId))}, aspect: ${aspectRatio}, systemInstruction: ${!!systemInstruction}`);

  // Safety-block ladder: level 0 is the prompt as built, level 1 asks a text
  // model to REWRITE the scene — defuse the safety trigger while keeping the
  // story moment (same rewriteBlockedScene used by the main generation path).
  // If the rewritten scene is STILL blocked, this function throws — a wrong
  // image is worse than no image, and so is a mutilated prompt. Every earlier
  // rung (the generic one-liner prompts, then the 78-word local strip) is gone;
  // the PROMPT SANITIZATION note near the top of this file records what each
  // one cost and the measurements that retired it.
  // Every rung rebuilds from what level 0 actually SENT — `parts[0].text`, the
  // post-shrink string — not from the raw `prompt` argument. The two diverge on
  // the Grok→Gemini fallback: shrinkPromptForModel ran against the GROK model's
  // 7,900-char cap (models.js) before the swap to gemini-2.5-flash-image, while
  // `prompt` can be 22k (measured max in stories.data). Rebuilding a "retry"
  // from `prompt` silently re-expanded it by thousands of characters, so what
  // got retried was not the request that had just been refused. Same
  // sent-equals-stored equality that stored-prompt-is-sent-prompt.test.ts pins
  // for the level-0 path.
  const sentPrompt = parts[0]?.text || effectivePrompt;

  const rewriteSceneInPrompt = async () => {
    const { callTextModel } = require('./textModels');
    const sceneMatch = sentPrompt.match(/\*\*THIS IMAGE DEPICTS:\*\*\s*([\s\S]*?)(?=\n\n\*\*|$)/i)
      || sentPrompt.match(/\*\*SCENE:\*\*\s*([\s\S]*?)(?=\n\n\*\*|$)/i)
      || sentPrompt.match(/Scene Description:\s*([\s\S]*?)(?=\n\n\*\*|$)/i);
    const originalScene = sceneMatch?.[1]?.trim();
    const rewriteResult = await rewriteBlockedScene(originalScene || sentPrompt, callTextModel);
    // Replace the scene block in place so style / reference / no-text rules
    // survive; when no scene block was found (custom prompts like
    // scale-repair or empty-scene), use the rewrite as the whole prompt.
    // The replacement is a FUNCTION: a `$&`, `$'` or `$1` sequence in
    // MODEL-authored text is a substitution pattern to String.replace, which
    // would splice a copy of the matched scene back into the prompt. A replacer
    // function is taken literally.
    return originalScene ? sentPrompt.replace(originalScene, () => rewriteResult.text) : rewriteResult.text;
  };
  const sanitizationLevels = [
    null,                   // Level 0: the prompt as sent
    rewriteSceneInPrompt,   // Level 1: text-model scene rewrite (keeps the story moment)
  ];

  for (let sanitizationLevel = 0; sanitizationLevel < sanitizationLevels.length; sanitizationLevel++) {
    // Apply sanitization if needed
    let currentPrompt = sentPrompt;
    if (sanitizationLevel > 0) {
      try {
        currentPrompt = await sanitizationLevels[sanitizationLevel]();
      } catch (rewriteErr) {
        log.warn(`⚠️ [IMAGE GEN-ONLY] Level ${sanitizationLevel} prompt rewrite failed: ${rewriteErr.message}`);
        throw new Error(`Image blocked and scene rewrite failed: ${rewriteErr.message}`);
      }
      parts[0] = { text: currentPrompt };
      log.info(`🔄 [IMAGE GEN-ONLY] Retry with sanitization level ${sanitizationLevel} (scene rewrite), prompt: ${currentPrompt.substring(0, 100)}...`);
    }

    try {
      const data = await withRetry(async () => {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          }
        );

        if (!response.ok) {
          const error = await response.text();
          log.error('❌ [IMAGE GEN-ONLY] Gemini API error response:', error);
          const err = new Error(`Gemini API error (${response.status}): ${error}`);
          err.status = response.status;
          throw err;
        }

        return response.json();
      }, { maxRetries: 2, baseDelay: 2000 });

      // Extract token usage
      const usage = {
        input_tokens: data.usageMetadata?.promptTokenCount || 0,
        output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
        thinking_tokens: data.usageMetadata?.thoughtsTokenCount || 0
      };

      if (!data.candidates || data.candidates.length === 0) {
        // No candidates = likely safety block
        log.warn(`⚠️ [IMAGE GEN-ONLY] No candidates (safety block?) at level ${sanitizationLevel}`);
        if (sanitizationLevel < sanitizationLevels.length - 1) continue;
        throw new Error('No image generated - no candidates in response');
      }

      const candidate = data.candidates[0];
      const thinkingText = extractThinkingFromParts(candidate.content?.parts, 'IMAGE GEN-ONLY');

      // Candidate-level refusal. ALLOW-LIST since 2026-09-18 (imageReplyGuard):
      // only a finish reason that MEANS the model finished lets the response
      // through. The old test named SAFETY and PROHIBITED_CONTENT alone, so
      // every other refusal — RECITATION, BLOCKLIST, SPII, LANGUAGE, OTHER and
      // the whole IMAGE_* family, IMAGE_OTHER included — fell past it into the
      // parts loop and was caught only by the "no image data" fall-through
      // below, under a vaguer log line. MAX_TOKENS is deliberately NOT a block
      // here: it keeps falling through exactly as before.
      const block = assessImageResponse(data);
      if (block.blocked) {
        log.warn(`⚠️ [IMAGE GEN-ONLY] Content ${describeImageBlock(block)} at level ${sanitizationLevel}`);
        if (sanitizationLevel < sanitizationLevels.length - 1) continue;
        throw new Error(`Image blocked by API: reason=${block.reason}`);
      }

      if (candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          const inlineData = part.inlineData || part.inline_data;
          if (inlineData && inlineData.data) {
            const pngImageData = `data:image/png;base64,${inlineData.data}`;
            const compressedImageData = await compressImageToJPEG(pngImageData);

            if (onImageReady) {
              try {
                await onImageReady(compressedImageData, modelId);
              } catch (callbackError) {
                log.error('⚠️ [IMAGE GEN-ONLY] onImageReady callback error:', callbackError.message);
              }
            }

            const result = {
              imageData: compressedImageData,
              // parts[0] holds the exact sent text — after a safety block the
              // sanitized/rewritten prompt, not the original.
              prompt: parts[0]?.text || effectivePrompt,
              modelId,
              thinkingText,
              usage,
              // Which rung produced this image: 0 = the prompt as built,
              // 1 = after the scene rewrite. (Level 1 meant the local word
              // strip until 2026-09-18; nothing reads this field — verified
              // repo-wide, and `$.**.sanitizationLevel` returns zero rows in
              // both environments' stories.data — so the renumber is safe.)
              sanitizationLevel,
              // Reconstruction record — refs were in parts but never stamped.
              // NOTE ON THE COUNT (documented 2026-08-29): on this GEMINI
              // FALLBACK path the field holds the UNPACKED part list — one
              // image per character plus the scene plate plus the VB grid — so
              // it routinely holds 4-7 entries. That is NOT a breach of Grok's
              // 3-slot cap: the Grok branches above store `packedRefs`, which
              // packReferences hard-limits to 3 (`slots.length >= 3`). A stored
              // page with >3 refs is by definition a Gemini render, and
              // `modelId` says so. Verified across job_1787959478282: every
              // page with 4/5/7 refs is gemini-2.5-flash-image, every
              // grok-imagine-image page has ≤3.
              grokRefImages: parts
                .filter(p => p.inline_data)
                .map(p => `data:${p.inline_data.mime_type};base64,${p.inline_data.data}`),
              ...sceneStamp()
            };

            if (!skipCache) imageCache.set(genOnlyCacheKey, result);
            if (sanitizationLevel > 0) {
              log.info(`✅ [IMAGE GEN-ONLY] Image generated with sanitization level ${sanitizationLevel}`);
            } else {
              log.info(`✅ [IMAGE GEN-ONLY] Image generated successfully`);
            }
            return result;
          }
        }
      }

      // No image data in response but also not explicitly blocked
      const reason = candidate.finishReason || 'unknown';
      log.warn(`⚠️ [IMAGE GEN-ONLY] No image data, reason=${reason} at level ${sanitizationLevel}`);
      if (sanitizationLevel < sanitizationLevels.length - 1) continue;
      throw new Error(`Image blocked by API: reason=${reason}`);

    } catch (error) {
      const errorMsg = error.message?.toLowerCase() || '';
      const isSafetyBlock = errorMsg.includes('blocked') || errorMsg.includes('safety') ||
                            errorMsg.includes('prohibited') || errorMsg.includes('filtered') ||
                            errorMsg.includes('no candidates') || errorMsg.includes('no image generated');

      if (isSafetyBlock && sanitizationLevel < sanitizationLevels.length - 1) {
        log.warn(`⚠️ [IMAGE GEN-ONLY] Safety block at level ${sanitizationLevel}, trying level ${sanitizationLevel + 1}...`);
        continue;
      }
      throw error;
    }
  }

  // Should not reach here, but just in case
  throw new Error('Image generation failed after all sanitization levels');
}

/**
 * Generate an image with iterative placement for scenes with characters at different depths.
 * Pass 1: Generate scene with only foreground character(s)
 * Pass 2: Send Pass 1 image as reference + background character avatar, ask model to add background character as tiny figure
 *
 * @param {string} prompt - The full image generation prompt
 * @param {Array} allCharacterPhotos - All character reference photos
 * @param {Object} sceneMetadata - Scene metadata with character depth info
 * @param {Object} options - Generation options
 * @returns {Promise<Object>} Image generation result
 */
async function generateWithIterativePlacement(prompt, allCharacterPhotos, sceneMetadata, options = {}) {
  const {
    imageModelOverride,
    imageBackendOverride,
    landmarkPhotos = [],
    visualBibleGrid = null,
    pageNumber = null,
    artStyle = '',
    // Plate or fail (server/lib/landmarkScene.js): the page's plate, and the
    // role of its landmark photo when it has none (cast-0 only).
    sceneBackground = null,
    landmarkScene = null,
  } = options;

  // 1. Split characters by depth from sceneMetadata.fullData (the parsed JSON scene object)
  // sceneMetadata.characters is string[] (names only), fullData.characters has depth/position/action
  const sceneChars = sceneMetadata?.fullData?.characters || [];
  const foregroundChars = [];
  const backgroundChars = [];

  for (const sc of sceneChars) {
    // Only "background" depth triggers two-pass (midground is close enough for single-pass)
    // Also check position string for "background" patterns from the iteration prompt
    const depth = (sc.depth || '').toLowerCase();
    const position = (sc.position || '').toLowerCase();
    if (depth === 'background' || position.includes('background')) {
      backgroundChars.push(sc);
    } else {
      foregroundChars.push(sc);
    }
  }

  // If no background chars, no structured data, or only 1 character total, use single-pass
  if (backgroundChars.length === 0 || sceneChars.length <= 1) {
    log.info(`🎯 [ITERATIVE] No background characters found (${sceneChars.length} chars, ${backgroundChars.length} bg), using single-pass generation`);
    return generateImageOnly(prompt, allCharacterPhotos, {
      imageModelOverride, imageBackendOverride, landmarkPhotos, landmarkScene, sceneBackground, visualBibleGrid, pageNumber, skipCache: true
    });
  }

  // 2. Split character photos by foreground/background
  const foregroundNames = new Set(foregroundChars.map(c => c.name));
  const foregroundPhotos = allCharacterPhotos.filter(p => foregroundNames.has(p.name || p.characterName));
  const backgroundNames = backgroundChars.map(c => c.name);
  const backgroundPhotos = allCharacterPhotos.filter(p => backgroundNames.includes(p.name || p.characterName));

  // Extract scene info for prompt building
  // Prose format: setting details are in imageSummary (the prose itself), no structured setting object
  const imageSummary = sceneMetadata?.fullData?.imageSummary || sceneMetadata?.imageSummary || '';
  const settingDesc = sceneMetadata?.fullData?.setting?.description || '';
  const camera = sceneMetadata?.fullData?.setting?.camera || 'wide shot';
  const fgNames = foregroundChars.map(c => c.name).join(', ');
  const bgNamesList = backgroundChars.map(c => c.name).join(', ');
  const styleLine = artStyle ? `**ART STYLE:** ${artStyle}\n\n` : '';

  // 3. Pass 1: Generate scene with ONLY foreground character(s)
  const fgCharDesc = foregroundChars.map(c =>
    `- ${c.name}: ${c.position || 'foreground'}, ${c.action || 'standing'}${c.expression ? ', ' + c.expression : ''}`
  ).join('\n');

  const pass1Prompt = fillTemplate(LOCAL_PROMPTS.iterativePlacementPass1, {
    STYLE_LINE: styleLine,
    SCENE_BODY: settingDesc || imageSummary,
    CAMERA: camera,
    FG_CHAR_DESC: fgCharDesc,
    FG_NAMES: fgNames,
  });

  log.info(`🎯 [ITERATIVE] Pass 1: ${foregroundPhotos.length} foreground chars (${fgNames}), excluding ${bgNamesList}`);
  log.info(`🎯 [ITERATIVE] Pass 1 prompt (${pass1Prompt.length} chars)`);

  let pass1Result;
  try {
    pass1Result = await generateImageOnly(pass1Prompt, foregroundPhotos, {
      imageModelOverride, imageBackendOverride, landmarkPhotos, landmarkScene, sceneBackground, visualBibleGrid, pageNumber, skipCache: true
    });
  } catch (err) {
    log.error(`🎯 [ITERATIVE] Pass 1 threw: ${err.message}`);
    throw err;
  }

  if (!pass1Result?.imageData) {
    log.error('🎯 [ITERATIVE] Pass 1 failed — no image generated');
    return pass1Result;
  }

  log.info(`🎯 [ITERATIVE] Pass 1 complete. Now adding ${backgroundChars.length} background character(s)...`);

  // 4. Pass 2: Add background character(s) to the Pass 1 image
  const bgCharDesc = backgroundChars.map(c => {
    const parts = [c.name];
    if (c.position) parts.push(`on the ${c.position}`);
    if (c.action) parts.push(c.action);
    if (c.clothing) parts.push(`wearing ${c.clothing}`);
    return parts.join(', ');
  }).join('\n- ');

  const pass2Prompt = fillTemplate(LOCAL_PROMPTS.iterativePlacementPass2, {
    STYLE_LINE: styleLine,
    FG_NAMES: fgNames,
    BG_CHAR_DESC: bgCharDesc,
  });

  log.info(`🎯 [ITERATIVE] Pass 2 prompt (${pass2Prompt.length} chars)`);

  let pass2Result;
  try {
    pass2Result = await generateImageOnly(pass2Prompt, backgroundPhotos, {
      imageModelOverride, imageBackendOverride,
      previousImage: pass1Result.imageData,
      // Pass 2 edits pass 1, which already carries the scene — no landmark photo.
      landmarkPhotos: [], visualBibleGrid,
      pageNumber, skipCache: true
    });
  } catch (err) {
    log.error(`🎯 [ITERATIVE] Pass 2 threw: ${err.message}`);
    return {
      ...pass1Result,
      iterativePlacement: true,
      pass2Failed: true,
      pass2Error: err.message,
      pass1Image: pass1Result.imageData,
      pass1Prompt: pass1Prompt,
      pass2Prompt: pass2Prompt,
      prompt: prompt,
    };
  }

  if (pass2Result?.imageData) {
    log.info(`🎯 [ITERATIVE] Pass 2 complete. Scene with iterative placement ready.`);
    return {
      ...pass2Result,
      iterativePlacement: true,
      pass1Image: pass1Result.imageData,
      pass1Prompt: pass1Prompt,
      pass2Prompt: pass2Prompt,
      prompt: prompt,
    };
  }

  // Pass 2 returned no imageData (shouldn't happen, but just in case)
  log.warn('🎯 [ITERATIVE] Pass 2 returned no imageData, returning Pass 1 result');
  return {
    ...pass1Result,
    iterativePlacement: true,
    pass2Failed: true,
    pass2Error: 'Pass 2 returned no imageData',
    pass1Image: pass1Result.imageData,
    pass1Prompt: pass1Prompt,
    pass2Prompt: pass2Prompt,
    prompt: prompt,
  };
}

// =============================================================================
// SEPARATED EVALUATION PIPELINE FUNCTIONS
// These functions support the unified pipeline architecture:
// 1. Generate ALL images first (generateImageOnly)
// 2. Evaluate ALL images in parallel (evaluateImageBatch)
// 3. Run the unified repair loop (runUnifiedRepairPipeline) which iterates,
//    inpaints, picks best versions, and runs character repair on entity issues
// =============================================================================


/**
 * Evaluate multiple images in parallel for quality and issues
 * This is used by the separated evaluation pipeline to evaluate all generated images at once
 *
 * @param {Array<Object>} images - Array of image objects
 * @param {string} images[].imageData - Base64 image data
 * @param {number} images[].pageNumber - Page number
 * @param {string} images[].prompt - The prompt used to generate the image
 * @param {Array} images[].characterPhotos - Character reference photos
 * @param {string} images[].sceneDescription - Scene description for metadata extraction
 * @param {string} images[].pageText - Story text for this page (for semantic fidelity check)
 * @param {string} images[].sceneHint - Direct statement of what image should show (for semantic eval)
 * @param {Object} options - Evaluation options
 * @param {number} options.concurrency - Max concurrent evaluations (default: 10)
 * @param {string|null} options.qualityModelOverride - Model override for quality evaluation
 * @returns {Promise<Array<Object>>} Array of evaluation results per page
 */
/**
 * Compose the reference list a page eval is judged against.
 *
 * Page photos win per name — they hold the outfit the page was generated
 * against — and the whole-cast list only appends the names the page omits.
 * Either side may legitimately be empty; an empty one never wins.
 *
 * @param {Array} pagePhotos - The page's own characterPhotos
 * @param {Array} wholeCastPhotos - Story-level reference photos (all characters)
 * @returns {Array} Merged reference list
 */
function composeEvalReferencePhotos(pagePhotos, wholeCastPhotos) {
  const page = Array.isArray(pagePhotos) ? pagePhotos.filter(Boolean) : [];
  const cast = Array.isArray(wholeCastPhotos) ? wholeCastPhotos.filter(Boolean) : [];
  const key = (p) => String(p?.name || '').trim().toLowerCase();
  const onPage = new Set(page.map(key).filter(Boolean));
  return [...page, ...cast.filter(p => !onPage.has(key(p)))];
}

async function evaluateImageBatch(images, options = {}) {
  const {
    concurrency = 100,
    qualityModelOverride = null,
    visualBible = null,
    clothingRequirements = null,
    artStyle = null,
    // Story context for the judge's cast resolver (main cast index) and the
    // clothing contract — without it every main-cast token logged unresolved.
    storyData = null,
    // Story-level context for eval_findings stats (best-effort; per-style works
    // from artStyle alone, the rest populate once the batch caller threads them).
    storyId = null,
    genre = null,
    language = null
  } = options;

  if (!images || images.length === 0) {
    return [];
  }

  log.info(`🔍 [BATCH EVAL] Evaluating ${images.length} images (concurrency: ${concurrency})...`);
  const startTime = Date.now();

  const evalLimit = pLimit(concurrency);

  const results = await Promise.all(images.map(img => evalLimit(async () => {
    const pageLabel = `PAGE ${img.pageNumber}`;
    try {
      // Skip if no image data
      if (!img.imageData) {
        log.warn(`⚠️  [BATCH EVAL] ${pageLabel}: No image data, skipping evaluation`);
        return {
          pageNumber: img.pageNumber,
          evaluated: false,
          error: 'No image data'
        };
      }

      // The clothing facts now travel as the CLOTHING CONTRACT input, built
      // inside evaluateImageQuality from these same photos — prepending them to
      // the prompt as well would state the outfit twice.
      //
      // NOT the sent prompt, deliberately: this site feeds the judge the scene
      // DESCRIPTION, and the resolveEvalArtStyle call below depends on that —
      // ORIGINAL_PROMPT here must carry no ART STYLE block.
      //
      // But when the page's built prompt went over the model cap,
      // shrinkPromptForModel COMPRESSED the scene prose before sending it, and
      // the description stored on the page still names clauses the model never
      // received. The shrink path now hands its compressed scene block back
      // (`compressedScene`), so that is what the judge scores against when it
      // exists. No shrink → the exact chain this site always used. The resolver
      // also re-checks the ART STYLE invariant on the compressed string, since
      // that head is LLM-rewritten. See
      // sceneMetadata.resolveEvalSceneDescription (sibling of
      // resolveEvalImagePrompt, which closed the six prompt-side sites).
      const sceneDescWithClothing = resolveEvalSceneDescription({
        compressedScene: img.compressedScene,
        sceneDescription: img.sceneDescription,
        prompt: img.prompt,
      });

      // Run quality evaluation (with parallel semantic fidelity check if pageText provided)
      // Use img.evaluationType if set (covers use 'cover' for text-focused eval)
      // Lab/staging parity: resolveEvalArtStyle is the ONE resolver both this
      // path and the Test Lab quality_eval stage use. ORIGINAL_PROMPT here is the
      // scene DESCRIPTION (no ART STYLE block), so without this every
      // style-dependent evaluator rule skipped silently in production too.
      //
      // The judge's reference list, and with it the CLOTHING CONTRACT the
      // eval builds from these refs' clothingDescription. The page's own
      // photos come first: they carry the outfit the page was actually
      // generated against (costumes, worn-item strips). A cover's description
      // has no clothing text, so a contract built from the story-level outfit
      // ruled the requested costume "unrequested" and the repair stripped it.
      // The whole-cast list then adds the characters the page did not list,
      // so identity checks still see the full cast.
      const refsForEval = composeEvalReferencePhotos(img.characterPhotos, img.allCharacterPhotos);
      const qualityResult = await evaluateImageQuality(
        img.imageData,
        sceneDescWithClothing,
        refsForEval,
        img.evaluationType || 'scene',
        qualityModelOverride,
        pageLabel,
        img.pageText || null,  // Story text for semantic fidelity check
        img.sceneHint || null, // Scene hint for semantic evaluation
        img.sceneCharacters || null,  // Enables STEP 2C head-to-body proportion check
        // evalOptions: story-level context so the eval records per-style/genre
        // stats to eval_findings (best-effort; no behaviour change).
        {
          // The bible the batch caller already holds. Reaches the evaluators'
          // INTERACTIONS_BLOCK and the cover fidelity reference, both of which
          // used to render raw VB ids into a judge's prompt.
          visualBible,
          artStyle: require('../services/prompts').resolveEvalArtStyle(artStyle, img.prompt || null),
          // Same reason the style is read off the built prompt here: the
          // REQUIRED OBJECTS checklist lives in the prompt TAIL, which the
          // judge's ORIGINAL_PROMPT (the scene description) deliberately does
          // not carry. Passed as its own input so D-16b can fire; falls back to
          // sceneMetadata.objects when no prompt was stored.
          pagePrompt: img.prompt || null,
          storyData,
          clothingRequirements,
          // Structured cover text contract from the pseudo-page record
          // (expectedText / textMode) — see evaluateImageQuality's cover branch.
          expectedText: img.expectedText ?? null,
          textMode: img.textMode ?? null,
          // Era-aware landmark protection: set by buildEvalInputs in the repair
          // pipeline (landmark refs + scene era). Absent → no protection.
          landmarkPhotos: img.landmarkPhotos || null,
          era: img.era || null,
          // The page's PARSED metadata, so the EXPECTED CAST roster reads the
          // brief's `objects[]` even when sceneHint is a plan line.
          sceneMetadata: img.sceneMetadata || null,
          // Covers only: the characters the generator was ORDERED to leave off
          // (cap + exclusion list, server/lib/coverCastRoster.js). The cover
          // branch of buildExpectedCastBlock reads the cover prose, which still
          // names them — without this the judge holds a roster the generator
          // was told to violate.
          excludedCastNames: img.excludedCastNames || null,
          // Detector figure count for the EXPECTED CAST block — present on
          // repair-round re-evaluations that carry the previous detection;
          // null on a first-round eval, which runs before detection.
          // Phase 5b-pre already detected on these exact bytes; the repair
          // rounds carry their own. Shared first, page second — never a new call.
          detectedFigures: img.sharedBboxDetection?.figures || img.bboxDetection?.figures || null,
          storyMeta: {
          storyId, pageNumber: img.pageNumber, artStyle, genre, language,
          charCount: Array.isArray(img.sceneCharacters) ? img.sceneCharacters.length : null,
        } }
      );

      // FLOOR (owner, 2026-08-26): an EMPTY figure inventory on a page whose
      // brief names characters is a failed look, not a perfect page. prod
      // job_1787689073034 p15 scored 100 with figures:[] on a page whose text
      // put a character alone in a crowd — silence read as perfection, the
      // same shape as the 2026-08-24 dead-evaluator bug. Severity-only change
      // (code may cap a score; classification stays with the prompt): cap at
      // 40 so the repair round looks at the page. Scene pages only.
      if (qualityResult
        && (img.evaluationType || 'scene') === 'scene'
        && Array.isArray(img.sceneCharacters) && img.sceneCharacters.length > 0
        && Array.isArray(qualityResult.figures) && qualityResult.figures.length === 0
        && typeof qualityResult.score === 'number' && qualityResult.score > 40) {
        log.warn(`⚠️ [BATCH EVAL] ${pageLabel}: figure inventory EMPTY while ${img.sceneCharacters.length} character(s) expected — score ${qualityResult.score} capped at 40`);
        qualityResult.score = 40;
        qualityResult.issuesSummary = `${qualityResult.issuesSummary ? qualityResult.issuesSummary + ' | ' : ''}figure inventory empty while ${img.sceneCharacters.length} character(s) expected — capped`;
      }

      // Use pre-extracted scene metadata if available, otherwise extract from scene description
      const sceneMetadata = img.sceneMetadata || (img.sceneDescription
        ? getStoryHelpers().extractSceneMetadata(img.sceneDescription)
        : null);
      const expectedCharacterPositions = sceneMetadata?.characterPositions || {};
      const expectedCharacterClothing = sceneMetadata?.characterClothing || {};
      const expectedObjects = sceneMetadata?.objects || [];

      // Use rich character descriptions from full character objects when available
      let characterDescriptions;
      if (img.sceneCharacters && img.sceneCharacters.length > 0) {
        characterDescriptions = {};
        for (const char of img.sceneCharacters) {
          // Resolve each category through the story's clothingRequirements
          // (signature → description → avatars.clothing fallback) — raw
          // avatars.clothing is character-level metadata that can be stale
          // across stories, so the evaluator judged against the wrong outfit.
          let clothingDescriptions = char.avatars?.clothing || {};
          if (clothingRequirements) {
            const { buildClothingDescription } = require('./entityConsistency');
            const { resolveCharacterReqs } = require('./clothingCategories');
            const categories = new Set([
              ...Object.keys(char.avatars?.clothing || {}),
              ...Object.keys(resolveCharacterReqs(clothingRequirements, char.name) || {}),
            ]);
            const resolved = {};
            for (const cat of categories) {
              resolved[cat] = buildClothingDescription(char, cat, artStyle, clothingRequirements);
            }
            clothingDescriptions = resolved;
          }
          characterDescriptions[char.name] = {
            richDescription: getStoryHelpers().buildCharacterPhysicalDescription(char),
            clothingDescriptions
          };
        }
      } else {
        // Fallback: parse minimal descriptions from prompt
        characterDescriptions = img.prompt
          ? getStoryHelpers().parseCharacterDescriptions(img.prompt)
          : {};
      }

      // Story-invented characters are in the Visual Bible, never in
      // sceneCharacters (that array is the photo-backed cast). Resolve the ones
      // this scene references so they reach the detector WITH a description —
      // a name-only entry can't tell figures apart. Same evidence as the shared
      // pre-detection in storyJobPipeline.js (job_1786737619634_d66c7bg9g p4:
      // Lira the mermaid missing → SoM answered A=Emma on the mermaid's badge).
      const sceneOnly = getStoryHelpers().buildSecondaryCharacterDescriptions(
        visualBible,
        getStoryHelpers().collectSceneCharacterNames(sceneMetadata, img.outlineCharacters || img.scene?.outlineCharacters || []),
        Object.keys(characterDescriptions),
        `PAGE ${img.pageNumber} `
      );
      if (Object.keys(sceneOnly).length > 0) {
        Object.assign(characterDescriptions, sceneOnly);
        log.debug(`📦 [BATCH EVAL] PAGE ${img.pageNumber}: ${Object.keys(sceneOnly).length} secondary character(s) from the Visual Bible: ${Object.keys(sceneOnly).join(', ')}`);
      }

      // ONE ROSTER (2026-09-13): membership comes from buildExpectedCastBlock,
      // the same answer the evaluator above was given. The rich descriptions
      // assembled here are untouched — only names the roster holds and this map
      // lacks are appended, so the detector can never be asked about a smaller
      // cast than the judge is scoring against.
      const { resolveExpectedCastNames, reconcileDetectorCast } = require('./evalPipeline');
      const authoritativeCast = resolveExpectedCastNames({
        sceneCharacters: img.sceneCharacters || null,
        sceneHint: img.sceneHint || null,
        originalPrompt: img.sceneDescription || '',
        visualBible,
        evaluationType: img.evaluationType || 'scene',
        pageLabel: `PAGE ${img.pageNumber} `,
        sceneMetadata,
        pageNumber: img.pageNumber,
        extraNames: img.outlineCharacters || img.scene?.outlineCharacters || [],
        storyData,
      });
      const castReconciled = reconcileDetectorCast(
        Object.entries(characterDescriptions).map(([name, d]) => ({ name, description: d?.richDescription || '' })),
        authoritativeCast,
        { visualBible, pageLabel: `PAGE ${img.pageNumber} `, storyData }
      );
      for (const name of castReconciled.added) {
        if (!characterDescriptions[name]) {
          const e = castReconciled.entries.find(x => x.name === name);
          characterDescriptions[name] = { richDescription: e?.description || '', clothingDescriptions: {} };
        }
      }

      // Parse Visual Bible objects from prompt
      const vbObjects = parseVisualBibleObjects(img.prompt || '');
      // Scene metadata emits VB IDs ("ART003", "LOC001.2"); translate them to
      // natural-language names from the visualBible before passing to the bbox
      // detector — opaque IDs have no visual meaning and cause found:false
      // entries that produce fake appearance records downstream.
      const mergedExpected = [...expectedObjects, ...vbObjects.filter(o => !expectedObjects.includes(o))];
      const allExpectedObjects = resolveExpectedObjectLabels(mergedExpected, visualBible);

      // Run bounding box detection for all figures/objects
      const fixableIssues = qualityResult?.fixableIssues || [];
      const qualityMatches = qualityResult?.matches || [];
      const objectMatches = qualityResult?.object_matches || [];

      let bboxDetection = null;
      let enrichedFixTargets = [];

      if (qualityResult) {
        const enrichResult = await enrichWithBoundingBoxes(
          img.imageData,
          fixableIssues,
          qualityMatches,
          objectMatches,
          expectedCharacterPositions,
          allExpectedObjects,
          characterDescriptions,
          expectedCharacterClothing,
          null,
          null,
          `PAGE ${img.pageNumber}`,
          img.sharedBboxDetection || null, // Reuse pre-detected bbox if available
          artStyle,
          buildObjectGroundingHints(allExpectedObjects, visualBible),
          visualBible
        );
        bboxDetection = enrichResult.detectionHistory;
        enrichedFixTargets = enrichResult.targets || [];
        // Alongside expectedCharacters, never instead of it (see site A).
        if (bboxDetection) bboxDetection.expectedCastNames = castReconciled.names;
      }

      // WHO IS WHO — reconcile the evaluator against the detector before any
      // downstream consumer reads a name off this evaluation. This is the only
      // point where both identities exist side by side; after it, `matches` and
      // every per-character finding carry the detector's names. Enrichment above
      // pairs on geometry, not names, so it is unaffected by the correction.
      //
      // AWAITED (2026-09-18). Reconciliation used to be a pure function of two
      // stored lists. It now asks a THIRD witness on the pages where the two
      // genuinely disagree AND the detector is about to overwrite the
      // evaluator — one Set-of-Mark call from a later tier of the same chain,
      // measured at 19 of 1,194 stored staging versions and 0 of 317 on
      // production. That makes this a network call, so it is awaited here. It
      // sits inside the per-page eval task (pLimit, one per page, default
      // concurrency 100), so a contested page waits for its own witness and no
      // other page waits for it.
      let identityAgreement = null;
      if (qualityResult && bboxDetection?.figures?.length) {
        const { reconcileIdentityWithSecondWitness, describeIdentityAgreement } = require('./identityAgreement');
        identityAgreement = await reconcileIdentityWithSecondWitness(qualityResult, bboxDetection.figures, {
          alsoRename: [enrichedFixTargets],
          // Closure, not an import inside identityAgreement: that module is a
          // leaf and stays one. Never called on an uncontested page — the
          // reconciler decides whether the answer can change anything before it
          // spends the call.
          secondOpinion: () => require('./figureDetection').secondOpinionIdentity(
            img.imageData,
            bboxDetection.figures,
            bboxDetection.expectedCharacters,
            `PAGE ${img.pageNumber}: `,
            // The tier that already answered is not a second witness.
            { excludeModel: bboxDetection.gdinoDiag?.identity?.model || null },
          ),
          // THE ARBITER — reached only when the detector, the evaluator and the
          // second witness deadlock (detector alone against the other two). The
          // detector is master for identity, so this is the ONE call allowed to
          // rename one of its figures. It is deliberately not another SoM
          // reading: it gets the page, a tight crop per contested figure, and
          // the contested names' clothing contract + reference face, because
          // clothing is what identity in this pipeline is made of.
          arbiter: ({ conflicts }) => require('./figureDetection').arbitrateIdentity(
            img.imageData,
            bboxDetection.figures,
            conflicts.map(c => c.detIndex),
            {
              pageLabel: `PAGE ${img.pageNumber}: `,
              // Both claims are candidates — the arbiter is never told which
              // side claimed which, so it cannot side with a witness.
              candidates: [...new Set(conflicts.flatMap(c => [c.detector, c.evaluator]))]
                .map(name => {
                  const ref = (refsForEval || []).find(r => r && r.name === name);
                  return { name, clothing: ref?.clothingDescription || null, faceDataUri: ref?.photoUrl || null };
                }),
            },
          ),
        });
        if (identityAgreement?.conflicts?.length) {
          log.warn(describeIdentityAgreement(identityAgreement, `PAGE ${img.pageNumber}: `));
          // The disagreements ARE the corpus — the hardest images we have.
          require('./identityCorpus').harvestIdentityConflict({
            storyId, pageNumber: img.pageNumber, report: identityAgreement,
          });
        } else if (identityAgreement) {
          log.debug(describeIdentityAgreement(identityAgreement, `PAGE ${img.pageNumber}: `));
        }
      }

      // TWO WITNESSES FOR AN ABSENCE (owner, 2026-08-27) — FOLDED INTO THE
      // DERIVATION (owner, 2026-09-13). The principle stands: an absence claim
      // is the one finding built on NOT seeing something, so a single blind
      // spot can fabricate it. It no longer runs here as an after-the-fact
      // filter deleting claims one at a time (and rescoring behind them).
      // evalPipeline.derivePresenceFinding now compares the detector count
      // against the evaluator own enumeration BEFORE any claim is made, and
      // declines to derive at all when they disagree.

      // Create bbox overlay image for dev mode display
      let bboxOverlayImage = null;
      if (bboxDetection) {
        bboxOverlayImage = await createBboxOverlayImage(img.imageData, bboxDetection);
      }

      const evalResult = {
        pageNumber: img.pageNumber,
        // A null qualityResult is a FAILED eval — evaluateImageQuality returns
        // null on its failure paths (blocked response, MAX_TOKENS exhaustion,
        // unparseable output, catch). Stamping such a record evaluated:true
        // handed downstream score:null with empty issue lists, which applyScore
        // read as zero deductions → finalScore 100: the failed eval outranked
        // every genuinely-evaluated repair in pickBestVersionIndex and dodged
        // findBadPages' evaluated===false redo branch (repairLogic.js), the
        // branch written for exactly this case. evaluated:false routes it there.
        evaluated: !!qualityResult,
        evalError: qualityResult ? null : 'evaluator returned no result',
        // Fingerprint of the EXACT bytes this eval scored. applyScore copies it
        // onto the version; pickBestVersionIndex refuses a score whose version
        // bytes no longer hash to it. Guards the eval↔bytes pairing the same way
        // sourceImageFp guards detections (job_1786571353564 p4: a version
        // shipped red bytes carrying the eval of its yellow predecessor).
        evalImageFp: hashImageData(img.imageData),
        score: qualityResult?.score ?? null,                    // Combined final score
        qualityScore: qualityResult?.qualityScore ?? qualityResult?.score ?? null,  // Visual quality only
        semanticScore: qualityResult?.semanticScore ?? null,    // Semantic fidelity only
        reasoning: qualityResult?.reasoning || null,
        verdict: qualityResult?.verdict || null,
        issuesSummary: qualityResult?.issuesSummary || null,
        fixableIssues: qualityResult?.fixableIssues || [],
        fixTargets: qualityResult?.fixTargets || [],
        enrichedFixTargets,
        figures: qualityResult?.figures || [],
        matches: qualityResult?.matches || [],
        objectMatches: qualityResult?.object_matches || [],
        // evaluateImageQuality returns these three, but this batch wrapper
        // rebuilds a whitelisted eval object and used to drop them — which is
        // why every stored scene had qualityRawOutput/evalTemplateHash null
        // even though repairPipeline maps finalEval.rawOutput into the scene
        // (O7) and buildVersionEntry reads evaluation.coherenceGate. The
        // whitelist, not the mapping, was the leak.
        rawOutput: qualityResult?.rawOutput ?? null,
        evalTemplateHash: qualityResult?.evalTemplateHash ?? null,
        coherenceGate: qualityResult?.coherenceGate ?? null,
        // Same whitelist lesson as rawOutput/coherenceGate above: a field not
        // listed here never reaches the stored version, however faithfully the
        // evaluator produced it.
        styleGate: qualityResult?.styleGate ?? null,
        bboxDetection,
        // Who-is-who agreement between this evaluation and the detection above.
        // Kept on the record so a stored page still shows whether its names were
        // contested, and which way they were corrected.
        identityAgreement,
        bboxOverlayImage,
        usage: qualityResult?.usage || null,
        modelId: qualityResult?.modelId || null,
        // Semantic fidelity results (parallel evaluation when pageText provided)
        semanticResult: qualityResult?.semanticResult || null,
        // Three-stage eval (vision-inventory + Sonnet compliance). Surfaced
        // verbatim so the dev panel can show Stage-1's free-form "what I see"
        // text and Stage-2's raw compliance JSON. Was being dropped before
        // this — only the score + issuesSummary survived.
        ...carryEvalEvidence(qualityResult),
        // Text error info for covers
        textIssue: qualityResult?.textIssue || null,
        expectedText: qualityResult?.expectedText || null,
        actualText: qualityResult?.actualText || null
      };

      log.debug(`✅ [BATCH EVAL] ${pageLabel}: Quality ${evalResult.qualityScore ?? 'N/A'}%, Semantic ${evalResult.semanticScore ?? 'N/A'}%, Final ${evalResult.score ?? 'N/A'}%, ${enrichedFixTargets.length} fix targets`);
      return evalResult;
    } catch (error) {
      log.error(`❌ [BATCH EVAL] ${pageLabel}: Evaluation failed - ${error.message}`);
      return {
        pageNumber: img.pageNumber,
        evaluated: false,
        error: error.message
      };
    }
  })));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const successCount = results.filter(r => r.evaluated).length;
  log.info(`✅ [BATCH EVAL] Completed ${successCount}/${images.length} evaluations in ${elapsed}s`);

  return results;
}



// ============================================================================
// UNIFIED REPAIR PIPELINE
// Single pipeline: evaluate → regenerate (max 2) → pick best → character fix
// ============================================================================

/**
 * Select the best version from multiple image versions by score.
 * On tie, prefers the earlier version (less API cost).
 *
 * @param {Array<{imageData: string, score: number|null, source: string}>} versions
 * @returns {Object} The version with the highest score
 */

/**
 * Inpaint a page using Grok text edit. Builds an instruction from quality + semantic issues
 * and applies it via editImageWithPrompt().
 *
 * Reuses the same logic as the manual repair endpoint (POST /:id/repair/image/:pageNum).
 *
 * @param {string} imageData - Current image (base64 data URI)
 * @param {Object} evaluation - Evaluation result with fixableIssues, semanticResult, etc.
 * @param {Object} [options] - Optional overrides
 * @returns {Promise<{imageData: string|null, repaired: boolean, instruction: string|null, usage: Object|null}>}
 */
async function inpaintPage(imageData, evaluation, options = {}) {
  const {
    visualBible = null,
    characters = null,
    pageNumber = null,
    sceneDescription = '',
    artStyle = null,
    characterClothing = null,
    // Story-level clothing spec ({name: {standard: {description, signature}, ...}}).
    // Merged into the per-character requirements passed to getCharacterPhotoDetails
    // so resolveClothingDescription reads THIS story's clothing instead of falling
    // through to stale cross-story avatars.clothing.
    clothingRequirements = null,
    // Audit trail: when provided, consolidator calls get persisted to DB
    storyId = null,
    round = null,
    // Per-page aspect (e.g. '1:1' for advanced/Jugendbuch, '3:4' for standard).
    // Without this, inpaint produces 3:4 images for square pages — which then
    // become the active version after the round-1 score, silently changing the
    // book's layout. Falls through to editImageWithPrompt → Grok/Gemini.
    aspectRatio = null,
    // Page's locked text-overlay corner. When set, the inpaint instruction
    // gets a soft "Quiet zone:" suffix telling Grok not to introduce
    // high-contrast detail in that corner — same warning the character-fix
    // path uses. Without this, inpaint can paint a face/hat into the calm
    // zone when the bbox happens to overlap it.
    textPosition = null,
    // Era-aware landmark protection (2026-09-05): the real-landmark refs this
    // page was rendered from + the story era. Forwarded to the consolidator so
    // a present-day landmark's own structures are never removed by an unmasked
    // whole-frame edit. See server/lib/landmarkProtection.js.
    landmarkPhotos = null,
    era = null,
    // The page's scene metadata, so an element cited in a state (ART002.4)
    // resolves to the cell for the state THIS page needs.
    // The detector's named figures for THIS page. Only used to say WHERE a
    // figure stands when a fix instruction has to identify one by sight.
    detectedFigures = null,
    sceneMetadata = null,
    // The consolidated repair plan for THIS evaluation, produced once where the
    // evaluation was scored (see the B2 note below). Required — inpaint never
    // consolidates on its own.
    consolidatedPlan: consolidatedPlanIn = null,
    // A cover's structured text contract (coverTypography.resolveCoverTextContract).
    // A painted title / dedication / brand line joins the required-text clause
    // so a whole-frame edit keeps it; 'appOverlay' art is textless and adds nothing.
    expectedText = null,
    textMode = null,
  } = options;

  // Resolve the current-page clothing category for a character. Case-insensitive.
  // NO DEFAULT (owner, 2026-08-07): returns null when the scene metadata does
  // not list this character. The old 'standard' fallback named a category the
  // story may not use, which resolves to the character's stored wardrobe from
  // an unrelated story — and here that wardrobe becomes the REFERENCE IMAGE the
  // inpaint copies, so the guess is painted straight into the page.
  const clothingFor = (name) => {
    if (!characterClothing || !name) return null;
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(characterClothing)) {
      if (k.toLowerCase() === lower) return v ? String(v).toLowerCase() : null;
    }
    return null;
  };

  const { getStyledAvatarForClothing } = require('./entityConsistency');

  // Collect quality issues (legacy path)
  const qualityIssues = (evaluation.fixableIssues || []).map(i => ({
    description: i.description || i.issue || i,
    // The declared type travels with the issue: the inpaint router filters on
    // it (NOT_INPAINTABLE_TYPES below), and dropping it here left every quality
    // issue untyped, so the filter could never see one.
    type: i.type || i.subType || null,
    // The evaluator's own `fix` is an INSTRUCTION; `description` is a
    // diagnosis. The fallback below used to send the diagnosis, so Grok was
    // handed "apparent age 4 vs expected 5 years — slight under-ageing" and
    // asked to paint it (job_1787689073034_1v6ew0y1kae, backCover).
    fix: i.fix || null,
    source: 'quality'
  }));

  // Collect semantic issues (legacy path)
  const semanticIssues = require('./repairLogic').semanticFindings(evaluation.semanticResult)
    .map(si => ({
      description: require('./scoring').findingText(si),
      source: 'semantic',
      type: si.type,
      item: si.item,
      // The bible id the judge copied off PAGE ELEMENTS; the repair attaches
      // that element's reference by id below.
      element: si.element || null,
    }));

  // Combine and deduplicate
  const combinedIssues = [...qualityIssues, ...semanticIssues]
    .filter((issue, idx, arr) => {
      const desc = issue.description || '';
      return desc && arr.findIndex(i => (i.description || '') === desc) === idx;
    });

  // WHAT INPAINT MAY NOT BE ASKED TO DO (owner, 2026-08-26). Inpaint turns a
  // figure, moves it, changes hand pose, gaze or expression, and edits objects.
  // It cannot change clothing, hair, or the form of a face — asked to, it
  // repaints the figure and the result drifts from the character. Those defects
  // belong to character repair (avatar-anchored) or to a page redo, and both
  // routes already exist; sending them here spends a model call that can only
  // make the page worse.
  //
  // Measured on job_1787689073034_1v6ew0y1kae: 5 of 11 inpaint calls carried 9
  // such directives — "Change the hair color to light blonde", "Add the square
  // bib panel and two crossing shoulder straps", "Recolour the shorts", "Repaint
  // the hair light blonde and wavy", plus two pasted age findings.
  //
  // Filtering on the DECLARED type, never on the description prose: classifying
  // by reading the text is what docs/SETTLED.md forbids.
  const { NOT_INPAINTABLE_TYPES, typesAreInpaintable } = require('./repairLogic');
  const inpaintableIssues = combinedIssues.filter(i => {
    const t = String(i.type || '').toLowerCase();
    if (!t) return true;                       // untyped: leave the old behaviour alone
    if (!NOT_INPAINTABLE_TYPES.has(t)) return true;
    log.info(`[INPAINT PAGE] P${pageNumber}: "${t}" is not inpaintable — left for character repair`);
    return false;
  });

  if (combinedIssues.length === 0) {
    log.debug(`[INPAINT PAGE] No issues to fix, skipping inpaint`);
    return { imageData: null, repaired: false, instruction: null, usage: null };
  }

  // ---------------------------------------------------------------------------
  // ONE CONSOLIDATION PER EVALUATION (2026-09-21, finding B2). The repair
  // pipeline consolidates every evaluation the moment it lands and stores the
  // plan on the version (repairPipeline.consolidatePageEval → version
  // .consolidatedPlan, mirrored onto the eval object it hands to the repair).
  // Inpaint used to call the consolidator AGAIN on the same evaluation: staging
  // consolidator_calls rows show p10/p12/p15 consolidated at round 0 and again
  // inside inpaint at round 1, ~7k tokens each, with differing plans — so the
  // page was repaired from a plan nothing else had scored against.
  // The plan is an INPUT here now. NO FALLBACKS: an inpaint without one stops.
  // ---------------------------------------------------------------------------
  // ONE CLEAN FINDING NEEDS NO CONSOLIDATION (owner, 2026-09-20). The
  // consolidator exists to dedupe findings across evaluators, split per-character
  // from scene work, strip character names, and cap at 3. When a single issue
  // arrives already phrased as an instruction and already free of names, every
  // one of those jobs is a no-op — and the critique-and-trim step still runs,
  // which is pure loss: on job_1789853503332 it cut a 49-word scale fix down to
  // "Resize the egg to match the size of the boy", deleting the word "smaller".
  // A target with no direction is read as already satisfied, so the repair did
  // nothing on one page and inverted on the other. Send the finding as written.
  // WHO A FIX IS ABOUT, by sight: every cast and bible-figure name this page's
  // repair text may carry, mapped to its descriptor. Built once, read by the
  // shortcut check below and by the plan's name strip.
  const { buildRepairNameMap, nameRepairText, resolveRepairIds } = require('./repairLogic');
  const repairNameMap = buildRepairNameMap({
    characters, visualBible, characterClothing, clothingRequirements, artStyle, detectedFigures, pageNumber,
  });

  const soleDirectFix = (() => {
    if (inpaintableIssues.length !== 1) return null;
    const only = inpaintableIssues[0];
    const fix = typeof only.fix === "string" ? only.fix.trim() : "";
    if (!fix) return null;
    // Rule 3 is the consolidator’s to enforce: if a name is present — written,
    // or as a figure id that resolves to one — it has real work to do and we
    // do not shortcut past it.
    if (nameRepairText(fix, repairNameMap) !== resolveRepairIds(fix, repairNameMap)) return null;
    return fix;
  })();

  // The plan produced when this evaluation was scored. The pipeline mirrors it
  // onto the eval object (repairPipeline roundEvalPages) and also passes it
  // explicitly; both name the same object.
  const storedPlan = consolidatedPlanIn || evaluation?.consolidatedPlan || null;

  let consolidation = null;
  if (soleDirectFix) {
    log.info(`[INPAINT PAGE] P${pageNumber}: one name-free finding with its own instruction — sent verbatim, no consolidation`);
  } else if (storedPlan) {
    consolidation = { plan: storedPlan, error: null };
    log.info(`[INPAINT PAGE] P${pageNumber}: using the plan consolidated with this evaluation (no second consolidator call)`);
  } else {
    // A repair with no plan and no single self-describing finding has nothing
    // to send Grok. Re-consolidating here is what B2 deleted; degrading to the
    // legacy issue-concat is a fallback. Stop, loudly.
    log.error(`❌ [INPAINT PAGE] P${pageNumber}: no consolidated plan on the evaluation — inpaint cannot run (the plan is produced where the evaluation is scored)`);
    return { imageData: null, repaired: false, instruction: null, usage: null, error: 'no consolidated plan on the evaluation' };
  }

  // Decide the instruction to send Grok: scene_fix.instruction + avatars of any
  // character referenced in per_character_fixes (Grok now KNOWS who to fix).
  // There is no second path — a missing plan already returned above.
  let editInstruction;
  // What must still be TRUE after the edit (scene_fix.preserve), as opposed to
  // what the edit DOES. Built in the plan branch, appended below.
  // See repairLogic.buildPreserveClause for why this channel exists.
  let preserveClause = '';
  let consolidatedPlan = null;
  const referenceImages = [];
  const referenceImageSources = [];

  if (soleDirectFix) {
    // Verbatim. No trim, no critique, no cap — there was nothing to consolidate.
    editInstruction = `1. ${sanitizeIssueForInpaint(soleDirectFix)}`;
  } else {
    consolidatedPlan = consolidation.plan;

    // SAFETY NET — Haiku is told never to use character names in fix
    // instructions, but sometimes slips "Werner's body" or "Lukas's gaze"
    // into the text. Strip every cast and bible-figure name and replace it
    // with the figure's own visual identifier (from per_character_fixes), else
    // the shared descriptor (repairLogic.buildRepairNameMap).
    // Per-name visual-identifier lookup from the consolidator plan.
    const visualIdByName = new Map();
    for (const pcf of (consolidatedPlan.per_character_fixes || [])) {
      if (pcf?.characterName && pcf?.visual_identifier) {
        visualIdByName.set(pcf.characterName.toLowerCase(), pcf.visual_identifier);
      }
    }
    // Fallback identifier when a name has no per_character_fixes entry to
    // borrow a `visual_identifier` from. "the character" loses WHO — observed:
    // "Add <object> held in one of the character's hands" let Grok pick the
    // wrong figure entirely.
    //
    // This used to be age + gender, built here. On a cast of four
    // three-year-old boys that is the SAME STRING for three of them —
    // "the 3-year-old male figure" — and it targets nobody (measured
    // 2026-09-22, p7 of job_1789853503332_riqncqg1i, where a grouped face fix
    // put every name down this path at once). What separates children is what
    // they are WEARING and where they STAND, and the page knows both, so the
    // descriptor is built by one helper off the canonical wardrobe renderer
    // rather than re-derived here.
    // The bible's named figures — creatures and secondary characters — are in
    // the same map (owner, 2026-09-24): a creature's name means nothing to the
    // image model either.
    // ONE PASS, NEVER RE-SCANNING WHAT WE INJECTED (owner, 2026-08-26). This
    // looped name-by-name, replacing into the running result. A
    // `visual_identifier` legitimately mentions other characters to locate its
    // subject ("the boy between <A> and <B>"), so the first substitution
    // injected those names back into the text and a later iteration replaced
    // them again, nesting the identifier inside itself. Measured on
    // job_1787689073034_1v6ew0y1kae initialPage, where the instruction reached
    // Grok as "...positioned between <A> and the boy in the center-left,
    // positioned between <A> and <B> appears" — no verb, no end, unpaintable.
    //
    // A single alternation over the ORIGINAL text fixes it by construction:
    // replacement output is never re-examined. Longest name first so a name
    // that contains another ("Anna Maria" over "Anna") wins.
    // VB ids resolve FIRST (nameRepairText): sanitizeVbIdsInPrompt turns a
    // figure's id into its name, so an id left for the later pass would come
    // back as the very name this strip removes.
    const stripNames = (text, ownVisualId, ownName = null) => nameRepairText(text, repairNameMap, {
      vidByName: visualIdByName, ownVisualId, ownName,
    });

    const sceneInstrRaw = consolidatedPlan.scene_fix?.instruction || '';
    // THE SCENE CHANNEL TAKES THE SAME GATE AS THE PER-CHARACTER ONE. The
    // 2026-08-28 fix below reached `per_character_fixes` only, so a scene fix
    // whose own declared types are all forbidden went through ungated — the
    // front cover of job_1789853503332_riqncqg1i carried
    // scene_fix.types ['extra_character'] and nothing stopped it.
    const sceneTypes = consolidatedPlan.scene_fix?.types;
    const sceneAllowed = typesAreInpaintable(sceneTypes);
    if (!sceneAllowed) {
      log.info(`[INPAINT PAGE] P${pageNumber}: dropping scene fix "${(Array.isArray(sceneTypes) ? sceneTypes : []).join('/')}" — not inpaintable, character repair or a page redo owns it`);
    }
    const sceneInstr = sceneAllowed ? stripNames(sceneInstrRaw, null) : '';
    // THE PLAN PATH NEEDED THE SAME GATE AS THE FALLBACK (owner, 2026-08-28).
    // NOT_INPAINTABLE_TYPES filtered `combinedIssues`, which only feeds the
    // consolidator-failed fallback. A plan's `per_character_fixes` bypassed it
    // entirely, and the consolidator's own rule 7 is verb-scoped ("replace the
    // face", "swap the head") so an age change phrased as a repaint walked
    // through: staging job_1787867402809_z9bwoo3yp p3 shipped "Repaint the
    // woman … to match a 22-year-old young adult" to inpaint, from an
    // `age_shift` finding.
    //
    // Filtering on the DECLARED types the consolidator now copies from
    // deduped_issues — never on the instruction prose. An entry with no types
    // is left alone: older plans predate the field, and silently dropping their
    // fixes would lose real pose work.
    const perCharSource = (consolidatedPlan.per_character_fixes || []).filter(p => {
      const types = Array.isArray(p?.types) ? p.types.filter(Boolean) : [];
      const blocked = !typesAreInpaintable(types);
      if (blocked) {
        log.info(`[INPAINT PAGE] P${pageNumber}: dropping "${types.join('/')}" fix for ${p.characterName || 'a character'} — not inpaintable, character repair owns it`);
      }
      return !blocked;
    });
    const perCharItems = perCharSource
      .map(p => {
        const visualId = p.visual_identifier || 'this character';
        // NO INSTRUCTION → NO WORK (owner ruling 2026-09-01, G5). An entry
        // whose fix_instruction is empty is DROPPED, never refilled from
        // `issues`: those are diagnoses, not edit instructions, and the old
        // `|| (p.issues||[]).join('; ')` fallback handed the defect prose to
        // Grok verbatim — job_1788215224103 p16 sent "appears visibly older…"
        // as the instruction and painted Lorena into her 60s (it shipped).
        const fixRaw = typeof p.fix_instruction === 'string' ? p.fix_instruction.trim() : '';
        if (!fixRaw) {
          log.warn(`[INPAINT PAGE] P${pageNumber}: per-character fix for ${p.characterName || visualId} has no fix_instruction — dropped (a diagnosis is not an edit instruction)`);
          return null;
        }
        const fix = stripNames(fixRaw, visualId, p.characterName || null);
        return { severity: p.severity, text: `For ${visualId}: ${fix}` };
      })
      .filter(x => x && x.text);

    // Merge scene fix + per-char fixes, order by severity (highest first), and
    // emit as a numbered list. Grok prioritises top items; putting the most
    // critical change first makes the instruction harder to ignore.
    // CATASTROPHIC included: without it the `?? 2` fallback ranked a
    // CATASTROPHIC fix as MODERATE, so the worst defect could sort below
    // real MAJORs instead of leading the numbered list.
    const SEV_RANK = { CATASTROPHIC: 5, CRITICAL: 4, MAJOR: 3, MODERATE: 2, MINOR: 1, NONE: 0 };
    const sevRank = (s) => SEV_RANK[String(s || 'MODERATE').toUpperCase()] ?? 2;
    const items = [];
    if (sceneInstr) items.push({ severity: consolidatedPlan.scene_fix?.severity, text: sceneInstr });
    for (const c of perCharItems) items.push(c);
    items.sort((a, b) => sevRank(b.severity) - sevRank(a.severity));
    editInstruction = items
      .map((it, i) => `${i + 1}. ${it.text}`)
      .join('\n');

    // THE PRESERVE CHANNEL IS WIRED (2026-09-19). A size or position change
    // strands whatever was touching the object unless the page's declared
    // interaction travels with it. The consolidator has always written that
    // clause into `scene_fix.preserve` (and the landmark guard seeds it) — and
    // it died here: nothing ever read the field. Character names are stripped
    // the same way the instructions are; Grok does not know them.
    {
      const { buildPreserveClause } = require('./repairLogic');
      const cleaned = (consolidatedPlan.scene_fix?.preserve || [])
        .map(item => (typeof item === 'string' ? stripNames(item, null) : ''));
      preserveClause = buildPreserveClause(cleaned);
    }

    // Note: avatars for per_character_fixes are NOT attached here. The figures
    // are already in the page image — Grok edits in place. Attaching the
    // standing-portrait avatar dragged Grok's pose toward the portrait
    // (characters drifted to the wrong positions, gestures mutated). The
    // page image is the best identity anchor for cosmetic fixes; avatars are
    // still attached below for "missing" issues where the figure isn't in the
    // page yet.

    const droppedAll = consolidatedPlan.dropped_issues || [];
    const deferred = droppedAll.filter(d => /capped at 3/i.test(d.reason || ''));
    const trueDrops = droppedAll.filter(d => !/capped at 3/i.test(d.reason || ''));

    log.info(`[INPAINT PAGE] P${pageNumber}: plan = ${consolidatedPlan.per_character_fixes.length} per-char + scene=${consolidatedPlan.scene_fix?.severity || 'NONE'}, ${deferred.length} deferred (cap=3), ${trueDrops.length} consolidated`);

    // Only flag drops that aren't the intentional cap-at-3 deferral. A
    // CRITICAL/MAJOR consolidated away (e.g. as a duplicate) is fine; one
    // dropped for an unrecognized reason is worth a warn.
    for (const d of trueDrops) {
      const issueText = d.issue || d.description || JSON.stringify(d);
      const reason = d.reason || '(no reason)';
      const sev = String(d.severity || '').toUpperCase();
      if (sev === 'CRITICAL' || sev === 'MAJOR') {
        log.info(`[INPAINT PAGE] P${pageNumber}: ${sev} consolidated — "${issueText}" (${reason})`);
      } else {
        log.debug(`[INPAINT PAGE] P${pageNumber}: dropped — "${issueText}" (${reason})`);
      }
    }
    for (const d of deferred) {
      const issueText = d.issue || d.description || JSON.stringify(d);
      log.debug(`[INPAINT PAGE] P${pageNumber}: deferred to next round — "${issueText}"`);
    }
  }

  // References BY ID. The semantic judge is shown PAGE ELEMENTS (id — name)
  // and copies the id onto each finding as `element`; here that id is looked
  // up in the bible and the cell for THIS page's state of it is attached, so
  // the repair is shown the thing it is asked to paint. Measured before this
  // existed (Lab set 32): a repair with no picture of the object never once
  // painted it, and with one it did — not reliably, but never without.
  // Nothing is read out of prose; an id the bible does not know is skipped.
  {
    const { VB_ID_PATTERN, baseVbId } = require('./vbIdGuard');
    const { elementRefCell } = require('./visualBible');
    const pools = ['artifacts', 'animals', 'secondaryCharacters', 'vehicles'];
    const attached = new Set();
    const MAX_ELEMENT_REFS = 2;
    const exactId = new RegExp('^' + VB_ID_PATTERN.source + '$');
    for (const issue of combinedIssues) {
      if (attached.size >= MAX_ELEMENT_REFS) break;
      const handle = String(issue.element || '').trim();
      if (!handle || !exactId.test(handle)) continue;
      const base = baseVbId(handle);
      if (!base || attached.has(base)) continue;
      let entry = null;
      for (const pool of pools) {
        entry = (visualBible?.[pool] || []).find(e => String(e?.id || '').toUpperCase() === base.toUpperCase());
        if (entry) break;
      }
      if (!entry) { log.info(`[INPAINT PAGE] P${pageNumber}: finding names ${handle} but the bible has no such element — no reference`); continue; }
      const { cell } = elementRefCell(entry, handle, pageNumber, sceneMetadata, visualBible);
      const bytes = await loadVbReferenceBytes(cell);
      if (!bytes) { log.info(`[INPAINT PAGE] P${pageNumber}: ${handle} ("${entry.name}") has no rendered reference — skipped`); continue; }
      referenceImages.push(`data:image/jpeg;base64,${bytes}`);
      referenceImageSources.push(`vb-element:${cell?.id || base}`);
      attached.add(base);
      log.info(`[INPAINT PAGE] P${pageNumber}: attaching ${cell?.id || base} ("${entry.name}") — the ${issue.type} finding names it`);
    }
  }
  // Find reference images for missing characters/animals from Visual Bible (still useful)
  const missingItems = combinedIssues.filter(i => i.type === 'missing_character' || i.type === 'missing_element');
  const missingIdx = buildCastIndex({ characters: characters || [] }, visualBible);
  for (const missing of missingItems) {
    const itemName = (missing.item || '').toLowerCase().trim();
    if (!itemName) continue;

    // hasElementReference, not a raw field read: a stated artifact's render
    // lives on a state row, so a raw check drops it from repair references.
    const hasRef = require('./visualBible').hasElementReference;

    // RESOLVE: one resolver decides who "item" names across the three people
    // pools; artifacts stay on their own (name/id) matching below — an
    // artifact is not a character.
    const missingEntry = resolveEntity(missing.item, missingIdx, { log, pageLabel: `P${pageNumber} ` });
    const vbAnimal = (missingEntry && missingEntry.kind === 'animal' && hasRef(missingEntry.entry))
      ? missingEntry.entry : null;
    if (vbAnimal) {
      const bytes = await loadVbReferenceBytes(vbAnimal);
      if (bytes) {
        referenceImages.push(`data:image/jpeg;base64,${bytes}`);
        referenceImageSources.push(`vb-animal:${missing.item}`);
        log.info(`[INPAINT PAGE] Adding VB animal reference for missing "${missing.item}"`);
        continue;
      }
    }
    const vbChar = (missingEntry && missingEntry.kind === 'secondary' && hasRef(missingEntry.entry))
      ? missingEntry.entry : null;
    if (vbChar) {
      const bytes = await loadVbReferenceBytes(vbChar);
      if (bytes) {
        referenceImages.push(`data:image/jpeg;base64,${bytes}`);
        referenceImageSources.push(`vb-char:${missing.item}`);
        log.info(`[INPAINT PAGE] Adding VB secondary character reference for missing "${missing.item}"`);
        continue;
      }
    }
    const vbArtifact = visualBible?.artifacts?.find(a => a.name?.toLowerCase() === itemName && hasRef(a));
    if (vbArtifact) {
      const bytes = await loadVbReferenceBytes(require('./visualBible').elementRefCell(vbArtifact).cell);
      if (bytes) {
        referenceImages.push(`data:image/jpeg;base64,${bytes}`);
        referenceImageSources.push(`vb-artifact:${missing.item}`);
        log.info(`[INPAINT PAGE] Adding VB artifact reference for missing "${missing.item}"`);
        continue;
      }
    }
    if (characters) {
      const mainChar = (missingEntry && missingEntry.kind === 'cast') ? missingEntry.entry : null;
      if (mainChar) {
        const pageClothing = clothingFor(mainChar.name);
        if (!pageClothing) {
          log.error(`❌ [INPAINT PAGE] ${mainChar.name}: no per-page clothing category — NOT adding an avatar reference. A guessed category would hand the inpaint an outfit from another story to copy.`);
          continue;
        }
        const avatar = await getStyledAvatarForClothing(mainChar, artStyle || 'watercolor', pageClothing);
        const photoUrl = typeof avatar === 'string' ? avatar : (avatar?.imageData || mainChar.photos?.body || mainChar.photos?.face);
        if (photoUrl && typeof photoUrl === 'string' && photoUrl.startsWith('data:image') && !referenceImages.includes(photoUrl)) {
          referenceImages.push(photoUrl);
          referenceImageSources.push(`avatar-missing:${missing.item}:${pageClothing}`);
          log.info(`[INPAINT PAGE] Adding ${pageClothing} avatar for missing "${missing.item}" (style=${artStyle || 'watercolor'})`);
        }
      }
    }
  }

  if (!editInstruction || editInstruction.trim().length === 0) {
    log.debug(`[INPAINT PAGE] Empty instruction after consolidation, skipping`);
    return { imageData: null, repaired: false, instruction: null, consolidatedPlan, usage: null };
  }

  // Append a quiet-zone reminder when the page reserves a text-overlay
  // corner. Same wording as the character-fix path so Grok gets the same
  // signal regardless of repair mode.
  const TEXT_POSITION_DESC_INPAINT = {
    'top-left': 'upper left corner',
    'top-right': 'upper right corner',
    'bottom-left': 'lower left corner',
    'bottom-right': 'lower right corner',
    'top-full': 'upper third (full width)',
    'bottom-full': 'lower third (full width)',
  };
  // Pull the per-page textZoneDescription out of the scene metadata so the
  // quiet-zone instruction names the actual surface ("deep grey November sky",
  // "wet cobblestones") instead of just saying "calm". Without this Grok
  // interprets "soft and calm" as "flat uniform color" and replaces the
  // overcast sky with a uniform grey wash, losing all atmospheric detail.
  let inpaintTextZoneDesc = null;
  if (sceneDescription) {
    try {
      const meta = getStoryHelpers().extractSceneMetadata(sceneDescription);
      inpaintTextZoneDesc = meta?.textZoneDescription || null;
    } catch { /* fall through with null */ }
  }
  // Quiet zone is a SCENE-page concept: text is overlaid client-side onto a
  // calm region of the page. Covers render their text baked into the image
  // (title upper-third, branding bottom-left) and have no reserved calm
  // area — applying a quiet-zone instruction here would falsely tell Grok
  // to keep e.g. the upper-left soft, which conflicts with the title.
  const isCover = typeof pageNumber === 'number' && pageNumber <= 0;
  const quietZoneSuffix = !isCover && textPosition && TEXT_POSITION_DESC_INPAINT[textPosition]
    ? `\n\nQuiet zone: keep the ${TEXT_POSITION_DESC_INPAINT[textPosition]} as ${inpaintTextZoneDesc ? `the established ${inpaintTextZoneDesc} — preserve its existing atmospheric character (clouds, gradient, texture)` : 'soft and visually calm'}. Do not introduce faces, hats, patterns, or other high-contrast detail there, and do not flatten it to a uniform color. It is intentional negative space in the composition.`
    : '';

  // Cover text. A BAKED front cover (SETTLED: model-baked title everywhere)
  // carries its title in the pixels and has no textless art layer to restamp
  // from, so the edit itself must keep it: the title rides the required-text
  // clause below. An app-overlay cover repaints the textless art and is
  // restamped afterward (restampCover) — its contract adds nothing here.

  // Strip entity-grid vocabulary ("cells A, D, F", "the reference (R)")
  // before the instruction reaches the image model — image models DRAW what
  // a prompt names. Previously only character-repair prompts were guarded.
  editInstruction = sanitizeIssueForInpaint(editInstruction);
  // Resolve raw VB ids that evals quote back verbatim ("missing ART001") —
  // an unresolved id makes Grok invent an object with the id painted on it
  // as lettering (observed: gadget labelled "ART001" instead of the VB
  // artifact, a child's backpack).
  {
    const { sanitizeVbIdsInPrompt } = require('./storyHelpers');
    editInstruction = sanitizeVbIdsInPrompt(editInstruction, visualBible, pageNumber);
  }
  // Same two guards the instruction body gets: entity-grid vocabulary and raw
  // VB ids must not reach Grok through this channel either.
  if (preserveClause) {
    const { sanitizeVbIdsInPrompt } = require('./storyHelpers');
    preserveClause = sanitizeVbIdsInPrompt(sanitizeIssueForInpaint(preserveClause), visualBible, pageNumber);
  }
  // REQUIRED TEXT (2026-09-21). A repaint whose defect IS the lettering could
  // never converge: the instruction arrived glyph-free ("replace the single
  // letter with a letter pair") and REPAIR_TEXT_GUARD forbade painting letters
  // at all. Same builder as the page prompt and the judges, so the repair is
  // asked for the exact string the page was asked for and is scored against.
  // Resolved from the page's own scene metadata ids, never from the prose.
  let requiredTextClause = '';
  try {
    const requiredTextLib = require('./requiredText');
    const pageObjectIds = Array.isArray(sceneMetadata && sceneMetadata.objects)
      ? sceneMetadata.objects
      : [];
    requiredTextClause = requiredTextLib.buildRequiredTextRepairClause(
      requiredTextLib.collectImageRequiredTexts({ objectIds: pageObjectIds, visualBible, expectedText, textMode })
    );
  } catch (err) {
    // Loud: a declared string that cannot be resolved must not be swallowed.
    log.error(`[INPAINT PAGE] Page ${pageNumber}: required-text clause could not be built - ${err.message}`);
  }
  const fullInstruction = `Fix these issues in this children's book illustration:\n${editInstruction}${preserveClause}${quietZoneSuffix}${requiredTextClause}`;
  log.info(`[INPAINT PAGE] Inpainting (refs: ${referenceImages.length}): ${editInstruction.substring(0, 200)}`);

  try {
    // No artStyle for a normal (local) edit — the source image already carries
    // the style and Grok matches the surrounding pixels; passing the resolved
    // descriptor there regressed inpaint quality versus the manual-repair path.
    // EXCEPTION — a reframe (rule 7b): the router (decideRepairMethod) sends
    // these to iterate, but the round-loop flip can bounce one back to inpaint
    // after an iterate regression. A reframe regenerates part of the frame, so
    // there are no surrounding pixels to match and "match the source" drifts to
    // photoreal — anchor the medium explicitly for that case only.
    const reframe = consolidatedPlan?.scene_fix?.requires_regeneration === true;
    // The page inpaint is painted by the PAGE RENDER tier (owner, 2026-09-07,
    // reversing the 2026-09-06 pin). A Standard-tier whole-frame edit of a
    // 2.0 render repaints everything it was not told to keep: it removed a
    // named animal's head (job_1788727233899 p7) and wiped two real landmarks
    // (job_1788614817116 p2). Char repair keeps its own 1.x pin.
    const editResult = await editImageWithPrompt(imageData, fullInstruction, CONFIG_DEFAULTS.pageRenderImage, referenceImages, reframe ? (artStyle || null) : null, aspectRatio);
    if (editResult?.imageData) {
      if (editResult.imageData.length < 1000) {
        log.warn(`[INPAINT PAGE] Edit produced too-small image (${editResult.imageData.length} chars), rejecting`);
        return { imageData: null, repaired: false, instruction: editInstruction, consolidatedPlan, usage: editResult.usage };
      }
      return {
        imageData: editResult.imageData,
        repaired: true,
        instruction: editInstruction,
        // The COMPLETE string handed to the editor — `instruction` is only its
        // core. Returned so the version this render becomes can record its own
        // prompt instead of inheriting the page's first-render prompt.
        promptSent: fullInstruction,
        referenceImages,
        referenceImageSources,
        consolidatedPlan,
        consolidatorUsage: consolidation?.usage || null,
        usage: editResult.usage,
      };
    }
    return { imageData: null, repaired: false, instruction: editInstruction, referenceImages, referenceImageSources, consolidatedPlan, usage: null };
  } catch (err) {
    log.error(`[INPAINT PAGE] Edit failed: ${err.message}`);
    return { imageData: null, repaired: false, instruction: editInstruction, referenceImages, referenceImageSources, consolidatedPlan, usage: null, error: err.message };
  }
}

/**
 * Unified repair pipeline — evaluates, picks ONE repair method per page per
 * round (skip / inpaint / iterate / char-fix), runs them in parallel, picks
 * best across all rounds, then runs the style-consistency audit.
 *
 * Flow:
 *   1. Evaluate all images: quality + semantic + entity (one parallel batch)
 *   2. Round loop (1 to maxPasses):
 *        - decideRepairMethod() per bad page → ONE method (or skip)
 *        - dispatch to executeIterateAction / executeInpaintAction /
 *          executeCharFixAction in parallel
 *        - re-evaluate every repaired page: quality + semantic + entity
 *          (entity included so rounds can compare scores like-for-like)
 *        - inpaint↔iterate flip on regression (lastRepairRegressed); char-fix
 *          stays char-fix when entity issues persist
 *   3. Pick best version per page (single pass over ALL rounds + original)
 *   4. Post-repair calm-zone recovery
 *   5. Style-consistency audit across the picked images
 *   6. Build final results
 *
 * Char-fix runs INSIDE the round loop as a per-page method choice — there is
 * no separate post-loop character-repair stage anymore. Entity consistency
 * is checked exactly once per round (Step 1's initial + Step 2's per-round)
 * and not separately at the end.
 *
 * @param {Array<Object>} rawImages - Array from Phase 5a, each with imageData, prompt, characterPhotos, etc.
 * @param {Object} context
 * @param {Array} context.characters - Character array
 * @param {Object} context.modelOverrides - Model overrides
 * @param {Function} context.usageTracker - (provider, usage, funcName, modelId) => void
 * @param {Object} context.visualBible - Visual bible object
 * @param {string} context.artStyle - Art style string
 * @param {string} context.jobId - Job ID for progress updates
 * @param {Object} context.dbPool - Database pool for progress updates
 * @param {Object} context.storyData - Full story data (needed for iteratePage mode)
 * @param {Object} [options]
 * @param {number} [options.regenThreshold=REPAIR_DEFAULTS.scoreThreshold] - Score below which to regenerate
 * @param {number} [options.maxRegenAttempts=REPAIR_DEFAULTS.maxPasses] - Max repair rounds
 * @param {number} [options.evalConcurrency=100] - Concurrency for evaluations
 * @param {string} [options.qualityModelOverride] - Model override for quality evaluation
 * @param {boolean} [options.useIteratePage=false] - Use iteratePage (re-expansion) instead of generateImageOnly
 * @param {number} [options.inpaintMaxPasses=1] - Inpaint attempts per page per round
 * @returns {Promise<{results: Array<Object>, charFixDetails: Object}>}
 */

/**
 * Resolve a character's face/body bbox for char-fix targeting AND for building
 * the protection list of OTHER characters on the same page.
 *
 * Single source-of-truth lookup so target and protection always agree:
 *   1. entityReport.characters[name].byClothing[*].appearances[pageNumber]
 *      — same upstream as bbox detection, but face boxes are cascade-improved
 *      (anime + Haar) when cascade ran. Prefer this over raw figures.
 *   2. bestEval.bboxDetection.figures[name] — canonical bbox detection result
 *      cached at img.sharedBboxDetection.
 *   3. bestEval.matches[name].face_bbox — quality eval's independent face
 *      detection (no bodyBox available here).
 *
 * Skips UNKNOWN figures. Case-insensitive name match. Normalises to
 * [y0, x0, y1, x1].
 *
 * @param {string} charName
 * @param {Object} sources
 * @param {Object} [sources.bestEval]
 * @param {Object} [sources.entityReport]
 * @param {number} sources.pageNumber
 * @returns {{ faceBbox: Array|null, bodyBbox: Array|null, source: string|null }}
 */


// ============================================================================
// CATEGORIZED REPAIR FUNCTIONS
// Different repair methods for different issue types
// ============================================================================

/**
 * Render ONE fresh people-free plate for a stored page from its plate
 * description (the brief's emptyScenePrompt). Shared by iteratePageCore and
 * the page regenerate route, so a repair renders its plate the one way.
 * Returns the plate data URI, or null on failure (logged).
 */
async function renderStoryPagePlate({
  storyData, visualBible, pageNumber, sceneMetadata = null, landmarkPhotos = [],
  plateDescription, textPosition = null, aspectRatio = null, imageModelOverride = null,
  save = null, logTag = 'ITERATE',
}) {
  if (!plateDescription) return null;
  try {
        const { resolveArtStyleForEmptyScene, resolveArtStyle: resolveStyleForEmpty } = getStoryHelpers();
        const iterBackend = imageModelOverride ? (IMAGE_MODELS[imageModelOverride]?.backend || null) : null;
        const artStyleDesc = resolveArtStyleForEmptyScene(storyData.artStyle || 'pixar', iterBackend)
          || resolveArtStyleForEmptyScene('pixar')
          || resolveStyleForEmpty(storyData.artStyle || 'pixar', iterBackend)
          || '';
        const textPos = textPosition || sceneMetadata?.textPosition || null;
        const { buildTextZoneInstruction, buildEraGuard } = getStoryHelpers();
        const iterateTextZoneDesc = sceneMetadata?.textZoneDescription || null;
        const iterateEra = sceneMetadata?.era || null;
        // Named landmark-fidelity block when this page attaches a landmark
        // photo (landmarkPhotos below) — '' otherwise. Shared builder
        // in storyHelpers; used to be built only on the TRIAL empty-scene
        // path while every other caller shipped the generic unnamed block.
        const iterateAboardId = sceneMetadata?.aboard || null;
        const { buildEmptyScenePrompt } = require('../services/prompts');
        const { buildLandmarkFidelityBlock } = getStoryHelpers();
        // Built BEFORE the prompt: which reference family is attached decides
        // the REFERENCE line (referenceKind below), exactly as at the
        // production page/vantage plate call sites and the Lab stage.
        const emptySceneVbGrid = await buildEmptySceneVbGrid(visualBible, pageNumber, landmarkPhotos, iterateAboardId, sceneMetadata?.objects || null);
        const emptyPrompt = buildEmptyScenePrompt({
          style: artStyleDesc,
          description: plateDescription,
          textAreaInstruction: textPos ? buildTextZoneInstruction(textPos, iterateTextZoneDesc, (storyData?.languageLevel === '1st-grade' ? '10%' : storyData?.languageLevel === 'advanced' ? '40%' : '30%'), { isEmptyScene: true }) : '',
          eraGuard: buildEraGuard(iterateEra),
          landmarkFidelity: buildLandmarkFidelityBlock(landmarkPhotos?.[0], { era: iterateEra }),
          // Tells the model what the attached reference IS (prompts.js
          // REFERENCE line). Same expression every other plate call site uses —
          // without it the repaired page's fresh plate got the landmark photo
          // as pixels but no line saying the place in the scene IS that photo.
          referenceKind: (landmarkPhotos?.length > 0) ? 'landmark' : (emptySceneVbGrid ? 'element' : null),
          visualBible,
          pageNumber,
          aboardId: iterateAboardId,
          // AD objects[] gates which vehicles enter the plate prompt + grid
          // (AD is the authority on vehicle presence; VB pages is only the menu).
          sceneObjects: sceneMetadata?.objects || null,
          // The page's declared time of day and weather (sceneLight.js).
          light: require('./sceneLight').declaredLight(sceneMetadata),
        });
        const isCoverPage = pageNumber < 0;
        const emptyResult = await generateImageOnly(emptyPrompt, [], {
          // Plates stay on the Standard tier regardless of the page tier.
          ...emptyScenePlateRouting(),
          landmarkPhotos: landmarkPhotos,
          visualBibleGrid: emptySceneVbGrid,
          pageNumber,
          skipCache: true,
          aspectRatio: isCoverPage ? CONFIG_DEFAULTS.coverAspect : (aspectRatio || CONFIG_DEFAULTS.pageAspect)
        });
        if (!emptyResult?.imageData) return null;
        if (save) await save(pageNumber, emptyResult.imageData);
        log.info(`🎬 [${logTag}] Page ${pageNumber}: fresh empty scene generated${save ? ' and saved' : ''}`);
        return emptyResult.imageData;
  } catch (e) {
    log.warn(`⚠️ [${logTag}] Page ${pageNumber}: fresh empty scene failed: ${e.message}`);
    return null;
  }
}

/**
 * PLATE OR FAIL for a render of a STORED page outside the pipeline (page
 * regenerate, the dev test-models / style-lab routes). A landmark page that is
 * not cast-0 renders on its stored plate; with none stored, one is rendered
 * (renderStoryPagePlate); with neither, it throws. Returns the render's
 * { sceneBackground, landmarkScene } — other pages get { null, role }.
 */
async function ensureStoryPagePlate({
  storyId, storyData, visualBible, pageNumber, sceneMetadata = null, sceneCharacters = null,
  landmarkPhotos = [], textPosition = null, aspectRatio = null, imageModelOverride = null,
  save = null, logTag = 'PAGE',
}) {
  const { loadStoredPagePlate } = require('./landmarkScene');
  const page = { sceneMetadata, sceneCharacters };
  if (!pageNeedsPlate(page, landmarkPhotos)) {
    return { sceneBackground: null, landmarkScene: pageLandmarkScene(page) };
  }
  let sceneBackground = await loadStoredPagePlate(storyId, pageNumber);
  if (sceneBackground) {
    log.info(`🎬 [${logTag}] Page ${pageNumber}: reusing the stored plate`);
  } else {
    const { resolvePagePlate } = getStoryHelpers();
    const plateDescription = sceneMetadata?.emptyScenePrompt
      || resolvePagePlate({ pageNumber, sceneMetadata, visualBible, outlinePlate: null })?.text
      || null;
    log.info(`🎬 [${logTag}] Page ${pageNumber}: landmark page has no stored plate — rendering one`);
    sceneBackground = await toPlateDataUri(await renderStoryPagePlate({
      storyData, visualBible, pageNumber, sceneMetadata, landmarkPhotos,
      plateDescription, textPosition, aspectRatio, imageModelOverride, save, logTag,
    }));
  }
  if (!sceneBackground) {
    log.error(`❌ [${logTag}] Page ${pageNumber}: landmark "${landmarkPhotos[0]?.name || 'unknown'}" has no plate and none could be rendered — not rendered on the raw photo`);
    throw new PlateRequiredError(`${logTag} page ${pageNumber}: landmark page has no plate and none could be rendered`);
  }
  return { sceneBackground, landmarkScene: null };
}

/**
 * The plate an ITERATE render of a page uses (iteratePageCore). Kept apart so
 * the decision replays without the scene rewrite around it.
 * PLATE OR FAIL (server/lib/landmarkScene.js): a landmark page that is not
 * cast-0 always renders on a plate — the one passed in or stored, else a fresh
 * one, else it throws. singlePassScene does not apply to it.
 * @returns {Promise<{sceneBackground: string|null, iteratePageRef: Object}>}
 */
async function resolveIteratePlate({
  pageNumber, storyData, visualBible, iterateSceneMetadata = null, sceneCharacters = null,
  pageLandmarkPhotos = [], sceneBackgroundIn = null, effectiveSinglePass = false,
  emptySceneCallbacks = null, lockedTextPosition = null, sceneAspect = null, imageModelOverride = null,
}) {
  // Resolve empty scene background.
  // If sceneBackgroundIn was pre-supplied (pipeline), use it directly.
  // If emptySceneCallbacks are provided (UI route), load/generate based on scene metadata.
  // singlePassScene flag forces a one-pass render with no plate.
  // One fresh plate for this page (shared renderer, renderStoryPagePlate).
  const renderFreshPlate = (plateDescription) => renderStoryPagePlate({
    storyData, visualBible, pageNumber, sceneMetadata: iterateSceneMetadata,
    landmarkPhotos: pageLandmarkPhotos, plateDescription, textPosition: lockedTextPosition,
    aspectRatio: sceneAspect, imageModelOverride, save: emptySceneCallbacks?.save || null,
  });

  // PLATE OR FAIL (server/lib/landmarkScene.js): a landmark page that is not
  // cast-0 always renders on a plate — the stored one when it exists, else a
  // fresh one, else it fails. singlePassScene does not apply to it.
  const iteratePageRef = { sceneMetadata: iterateSceneMetadata, sceneCharacters };
  const iterateNeedsPlate = pageNeedsPlate(iteratePageRef, pageLandmarkPhotos);

  let sceneBackground = sceneBackgroundIn;
  if (effectiveSinglePass && !iterateNeedsPlate) {
    sceneBackground = null;
    log.info(`🎛️ [ITERATE] Page ${pageNumber}: singlePassScene=true — skipping empty-scene plate`);
  } else if (!sceneBackground && emptySceneCallbacks) {
    // A landmark page reuses its stored plate unless the setting changed.
    if (iterateSceneMetadata?.reuseEmptyScene || (iterateNeedsPlate && iterateSceneMetadata?.reuseEmptyScene !== false)) {
      try {
        const existing = await emptySceneCallbacks.load(pageNumber);
        if (existing) {
          sceneBackground = existing;
          log.info(`🎬 [ITERATE] Page ${pageNumber}: reusing empty scene as style anchor`);
        }
      } catch (e) {
        log.debug(`[ITERATE] No empty scene for page ${pageNumber}: ${e.message}`);
      }
    } else if (iterateSceneMetadata?.reuseEmptyScene === false && iterateSceneMetadata?.emptyScenePrompt) {
      log.info(`🎬 [ITERATE] Page ${pageNumber}: generating fresh empty scene (setting changed)`);
      sceneBackground = await renderFreshPlate(iterateSceneMetadata.emptyScenePrompt);
    }
  }
  // Stored plates can arrive as raw base64 or a URL; the render only takes a
  // data URI (anything else is silently not sent), and a landmark page must
  // not lose its plate that way.
  if (iterateNeedsPlate) sceneBackground = await toPlateDataUri(sceneBackground);
  if (iterateNeedsPlate && !sceneBackground) {
    const { resolvePagePlate } = getStoryHelpers();
    const plateText = iterateSceneMetadata?.emptyScenePrompt
      || resolvePagePlate({ pageNumber, sceneMetadata: iterateSceneMetadata, visualBible, outlinePlate: null })?.text
      || null;
    log.info(`🎬 [ITERATE] Page ${pageNumber}: landmark page has no stored plate — rendering one`);
    sceneBackground = await toPlateDataUri(await renderFreshPlate(plateText));
    if (!sceneBackground) {
      log.error(`❌ [ITERATE] Page ${pageNumber}: landmark "${pageLandmarkPhotos[0]?.name || 'unknown'}" has no plate and none could be rendered — not rendered on the raw photo`);
      throw new PlateRequiredError(`ITERATE page ${pageNumber}: landmark page has no plate and none could be rendered`);
    }
  }
  return { sceneBackground, iteratePageRef };
}

/**
 * Core iterate function — shared by the pipeline (executeIterateAction) and the
 * UI route (POST /:id/iterate/:pageNum).  Analyzes the current image, re-expands
 * the scene description with Claude's 17-check prompt, then regenerates.
 *
 * @param {string} imageData - Current image data (base64)
 * @param {number} pageNumber - Page number being iterated
 * @param {Object} storyData - Full story data object
 * @param {Object} options
 * @param {Object}   options.modelOverrides       - { imageModel, sceneIterationModel, imageBackend }
 * @param {Function} options.usageTracker          - Usage tracking callback
 * @param {boolean}  options.useOriginalAsReference - Send current image as reference to generator
 * @param {Object}   options.evaluationFeedback    - { score, reasoning, fixableIssues }
 * @param {string}   options.sceneBackground       - Empty scene plate (base64) for composite
 * @param {boolean}  options.iterativePlacement    - Use two-pass iterative placement
 * @param {boolean}  options.blackoutIssues        - Black out fixTargets on input image
 * @param {Array}    options.fixTargets            - Fix target bboxes (required when blackoutIssues=true)
 * @param {boolean}  options.previewOnly           - Return prompt + mismatches without generating
 * @param {string}   options.customImagePrompt     - Override the built image prompt
 * @param {Object}   options.emptySceneCallbacks   - { load, save } for DB-backed empty scene handling
 *   load(pageNumber): Promise<string|null>  — load existing empty scene from DB
 *   save(pageNumber, imageData): Promise<void> — save generated empty scene to DB
 *   When omitted, empty scene is only used if sceneBackground is pre-supplied.
 * @returns {Promise<Object>} result object (see end of function)
 */
async function iteratePageCore(imageData, pageNumber, storyData, options = {}) {
  const {
    modelOverrides = {},
    usageTracker = null,
    useOriginalAsReference = false,
    evaluationFeedback = null,
    sceneBackground: sceneBackgroundIn = null,
    iterativePlacement = false,
    blackoutIssues = false,
    fixTargets: optionFixTargets = null,
    previewOnly = false,
    customImagePrompt = null,
    emptySceneCallbacks = null,
    // Per-scene aspect override — caller (regeneration route or repair pipeline)
    // passes the scene's saved imageAspect so the regenerated image matches the
    // shape the layout expects. null/undefined falls back to the global default.
    aspectRatio: aspectRatioIn = null,
    // freeIterate: opt into the looser scene-iteration-free.txt template.
    // Default (false) keeps the cast locked to the original scene and uses the
    // strict template (outline authoritative). When true, iterate may drop/swap
    // characters and reframe the scene to escape an impossible composition.
    freeIterate = false,
    // Reference mode + single-pass flag — see applyReferenceMode in storyHelpers.
    // null/undefined = inherit MODEL_DEFAULTS; otherwise one of strict|loose|styled-only|off.
    referenceMode = null,
    singlePassScene = null,
    // Phase 7: cell-crop refs from story-scoped 2×4 sheet (default on).
    // Each character's full-image styled-avatar reference is replaced with a
    // single body cell cropped out of story.data.characterAvatars[name][slot]
    // at the scene-expansion-prescribed pose. Falls through silently when
    // the story has no sheet for the character yet (legacy stories pre-Phase-1).
    useStorySheetCells = true,
    // Pipeline callers (executeIterateAction) score round results themselves
    // (round detect + batch eval) — they pass skipEval so pages are evaluated
    // exactly once per version. External callers (regen/iterate routes) keep
    // the scored contract: eval + detection run here.
    skipEval = false,
  } = options;
  const effectiveReferenceMode = referenceMode || CONFIG_DEFAULTS.referenceMode || 'strict';
  // Explicit boolean from caller wins over the run-level default.
  const effectiveSinglePass = typeof singlePassScene === 'boolean'
    ? singlePassScene
    : CONFIG_DEFAULTS.singlePassScene === true;
  // A FULL-STORY COVER IS A PAGE (2026-09-24, plan covers-as-pages Q7): it
  // iterates here, from the Art Director brief stored on its coverImages
  // record. coverIteratePath refuses a pre-change cover (no brief — plan Q1)
  // and names the trial path for a trial cover, which never comes here.
  const { coverKeyOfPage, coverIteratePath, COVER_TEXT_POSITION } = require('./coverBeats');
  const coverKey = coverKeyOfPage(pageNumber);
  if (coverKey && coverIteratePath(storyData, coverKey) !== 'page') {
    throw new Error(`[ITERATE] ${coverKey}: a trial cover iterates through iterateCover, never the page path`);
  }
  const coverRecord = coverKey ? storyData.coverImages[coverKey] : null;
  const sceneAspect = aspectRatioIn || (coverKey ? CONFIG_DEFAULTS.coverAspect : CONFIG_DEFAULTS.pageAspect);

  const {
    analyzeGeneratedImage
  } = require('./sceneValidator');

  const {
    getPageText,
    buildSceneDescriptionPrompt,
    buildImagePrompt,
    getCharacterPhotoDetails,
    buildAvailableAvatarsForPrompt,
    extractSceneMetadata,
    parseProseMetadataFormat,
    parseClothingCategory,
    getLandmarkPhotosForScene,
    convertClothingToCurrentFormat,
    buildSceneClothingRequirements
  } = getStoryHelpers();

  const { callClaudeAPI } = require('./textModels');
  const { getElementReferenceImagesForPage } = require('./visualBible');
  const { applyStyledAvatars } = require('./styledAvatars');

  // Extract story context
  const characters = storyData.characters || [];
  const language = storyData.language || 'en';
  const visualBible = storyData.visualBible || null;
  const clothingRequirements = storyData.clothingRequirements || null;
  const pageClothingData = storyData.pageClothing || null;
  const sceneDescriptions = storyData.sceneDescriptions || [];
  const artStyle = storyData.artStyle || 'pixar';

  // Get page text
  const fullStoryText = storyData.storyText || storyData.story || '';
  // A cover has no page text: its beat (the plan line) is its narrative anchor.
  const pageText = coverKey ? '' : getPageText(fullStoryText, pageNumber);
  if (!coverKey && !pageText) {
    throw new Error(`Page ${pageNumber} text not found`);
  }

  // Get current scene description — a cover's brief lives on its own record.
  const currentScene = coverKey
    ? { pageNumber, description: coverRecord.sceneDescription, outlineExtract: coverRecord.outlineExtract }
    : sceneDescriptions.find(s => s.pageNumber === pageNumber);
  if (!currentScene || !currentScene.description) {
    throw new Error(`No scene description found for page ${pageNumber}`);
  }

  // The page's textPosition is locked at first generation — iterate must NOT
  // re-pick it (would break the spread rule and shift the calm zone). Pull the
  // saved value from sceneImages so buildImagePrompt and the empty-scene
  // re-gen can both inject the same COPY SPACE instruction the original had.
  const savedScene = coverKey
    ? coverRecord
    : ((storyData.sceneImages || []).find(s => s.pageNumber === pageNumber) || {});
  // A cover's copy space is fixed by its beat (the title / dedication zone).
  const lockedTextPosition = coverKey ? COVER_TEXT_POSITION[coverKey] : (savedScene.textPosition || null);

  log.info(`🔄 [ITERATE] Page ${pageNumber}: Analyzing current image with vision model...`);

  // Step 1: Analyze the current image using analyzeGeneratedImage (composition analysis)
  // The analysis is told what each character is WEARING, and that text flows
  // into the scene rewrite as previewFeedback.composition. It must therefore
  // carry THIS PAGE's outfit: formatCharacterContext reads `_currentClothing`,
  // which only the per-page view of clothingRequirements carries. Passing the
  // story-level blob resolved every character to 'standard' → the unused
  // standard category has no description → buildClothingDescription fell
  // through to the character-level avatars.clothing.standard, and the rewrite
  // dressed a summer story in the stored winter/standard wardrobe (observed on
  // staging job_1786053708336_8cdsca519 p10: Noah's sky-blue polo became a
  // "dark green T-Rex hoodie, dark grey sweatpants" — his avatars standard
  // entry verbatim). Same reason only the page's cast is passed: an absent
  // character's outfit is noise the vision model can attach to a figure.
  const pageCharClothing = savedScene.perCharClothing
    || pageClothingData?.pageClothing?.[pageNumber]
    || null;
  // NO CAST FALLBACK (owner, 2026-08-08). The old code fell back to the whole
  // story roster when the page's cast was unknown. That is the same class of
  // guess as defaulting the clothing category, and it cost more: the roster
  // includes characters who are not in the picture, so the analysis described
  // absent people to the vision model AND the no-default clothing guard threw
  // on them (they legitimately have no per-page outfit), killing the repair for
  // every page of job_1786147254924_8nuyywjii. If we do not know who is on the
  // page, we do not guess — we fail here.
  const analysisCharacters = (() => {
    // RESOLVE: page cast names → roster entries through the one resolver.
    const iterateIdx = buildCastIndex({ characters: characters || [] }, visualBible);
    const names = (savedScene.sceneCharacters || []).map(c => String(c?.name || '').trim()).filter(Boolean);
    if (names.length === 0) {
      // An EMPTY cast and an UNKNOWN cast are different states. A landscape page
      // legitimately has nobody in it; a page whose prose names people the roster
      // could not resolve is a failure we must not paper over. The scene metadata
      // decides which one this is.
      const metaNames = (() => {
        try {
          const m = extractSceneMetadata(currentScene.description || currentScene.sceneDescription || '');
          const cs = m?.characters;
          return Array.isArray(cs) ? cs.map(c => String(c?.name || c || '').trim()).filter(Boolean) : [];
        } catch { return []; }
      })();
      if (metaNames.length === 0) {
        log.info(`🔄 [ITERATE] Page ${pageNumber}: scene has no characters — analysis runs without a cast`);
        return [];
      }
      // SECONDARY CHARACTERS are a third, legitimate state. They live in the
      // Visual Bible, not the roster: no photo, no avatar, no identity to check,
      // rendered from their VB description alone. getCharactersInScene matches
      // the ROSTER only, so a page whose cast is entirely secondary yields an
      // empty sceneCharacters — that is correct, not unknown. Only a name that
      // is in neither place means we genuinely do not know who is in the picture.
      const unknown = metaNames.filter((n) => {
        const e = resolveEntity(n, iterateIdx, { log, pageLabel: `P${pageNumber} ` });
        return !(e && e.kind === 'secondary');
      });
      if (unknown.length === 0) {
        log.info(`🔄 [ITERATE] Page ${pageNumber}: cast is entirely secondary characters (${metaNames.join(', ')}) — no roster identities to analyse`);
        return [];
      }
      throw new Error(`[ITERATE] Page ${pageNumber}: the scene names ${unknown.join(', ')}, who are in neither the story roster (${characters.map(c => c.name).join(', ')}) nor the Visual Bible's secondary characters. Refusing to fall back to the whole roster.`);
    }
    const wanted = new Set(names
      .map(n => resolveEntity(n, iterateIdx, { log, pageLabel: `P${pageNumber} ` }))
      .filter(e => e && e.kind === 'cast')
      .map(e => e.entry));
    const matched = characters.filter(c => wanted.has(c));
    if (matched.length === 0) {
      throw new Error(`[ITERATE] Page ${pageNumber}: none of the page's characters (${names.join(', ')}) match the story roster (${characters.map(c => c.name).join(', ')}). Refusing to fall back to the whole roster.`);
    }
    if (matched.length !== names.length) {
      log.warn(`⚠️ [ITERATE] Page ${pageNumber}: ${matched.length}/${names.length} scene characters matched the story roster`);
    }
    return matched;
  })();
  // buildSceneClothingRequirements itself throws when a cast member has no
  // per-page category — no second check here, one rule in one place.
  const analysisClothingRequirements = buildSceneClothingRequirements(
    analysisCharacters, pageCharClothing, clothingRequirements
  );
  const imageDescription = await analyzeGeneratedImage(imageData, analysisCharacters, visualBible, analysisClothingRequirements);
  log.info(`🔄 [ITERATE] Page ${pageNumber}: Composition analysis complete (${imageDescription.description.length} chars)`);

  // Step 2: Build previewFeedback from the image analysis.
  // Eval bullets from the previous round (if any) are routed here too so
  // Claude integrates them into the corrected scene — they must NOT go to
  // the image API, which can't reason about evaluator feedback.
  const previewFeedback = {
    composition: imageDescription.description,
    fixIssues: (() => {
      if (!evaluationFeedback) return [];
      const src = evaluationFeedback.fixableIssues || [];
      const issues = src.slice(0, 10).map(i => i?.description || i?.issue || String(i));
      // Consolidator-declared spec conflicts lead the list: the rewrite's
      // primary job is resolving them (change the interactions), not
      // re-transcribing the conflicting requirements from the story text.
      const conflicts = evaluationFeedback.consolidatedPlan?.spec_conflicts;
      if (Array.isArray(conflicts) && conflicts.length > 0) {
        issues.unshift(...conflicts.map(c =>
          `SPEC CONFLICT — rewrite the interactions to resolve: "${c.a}" vs "${c.b}"${c.why ? ` (${c.why})` : ''}`));
      }
      return issues;
    })(),
    previousScore: evaluationFeedback?.score ?? null,
  };

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

  // Get expected clothing for this page. NO DEFAULT (owner, 2026-08-07): this
  // value becomes the rewrite prompt's "This page's clothing" line, so a
  // guessed 'standard' actively instructs the rewriter to dress the page in a
  // category the story may not use.
  const expectedClothing = (coverKey ? coverRecord.perCharClothing : pageClothingData?.pageClothing?.[pageNumber])
    || pageClothingData?.primaryClothing;
  if (!expectedClothing) {
    throw new Error(`[ITERATE] Page ${pageNumber}: no per-page clothing and no primaryClothing on the story. Refusing to tell the rewriter 'standard'.`);
  }

  // Build available avatars
  const availableAvatars = buildAvailableAvatarsForPrompt(characters, clothingRequirements);

  // Extract short scene description from current scene
  // Handle both field names: 'description' (saved stories) and 'sceneDescription' (pipeline)
  const sceneDescText = currentScene.description || currentScene.sceneDescription || '';
  let shortSceneDesc = '';
  const sceneMetadata = extractSceneMetadata(sceneDescText);
  // THE PARENT BRIEF'S METADATA -- ONE RESOLVER (2026-09-17, staging
  // job_1789584708605_rts4wqupm). Everything an iterate carries forward or
  // checks against reads the brief this rewrite supersedes: the worn-item
  // states, the declared-set allowance, the citation-drop check. Every one of
  // them read `savedScene.sceneMetadata` alone -- and the repair pipeline
  // builds its own `sceneImages[]` rows (storyJobPipeline.js,
  // `pipelineStoryData`) from a whitelist that had no `sceneMetadata` key, so
  // on EVERY pipeline iterate that object was `{}`. All six rewrites of that
  // run came back with `wornItems: []`, and the jacket a page had taken OFF
  // was painted back on: p16 shipped at -12 with the surviving critical naming
  // exactly that. The page's own brief carries the same contract in the same
  // shape and is always present, so it is the fallback -- never `{}`.
  const parentSceneMetadata = savedScene?.sceneMetadata || sceneMetadata || {};
  if (sceneMetadata?.imageSummary) {
    shortSceneDesc = sceneMetadata.imageSummary;
  } else {
    shortSceneDesc = sceneDescText.substring(0, 500);
  }

  log.info(`🔄 [ITERATE] Page ${pageNumber}: Building scene description prompt with preview feedback (mode=${freeIterate ? 'free' : 'strict'})...`);

  // THE BEAT (owner, 2026-09-14). An iterate rewrites the whole brief, so it
  // needs the page's narrative intent — not a summary of the artefact it is
  // rewriting. See iterateBeat.js for what this fixes and for the rule that
  // keeps the rewriter's roster and the judge's roster the same one.
  const {
    resolvePlanLine, collectStagedFigures, collectPlanLineCast, renderStagedFiguresBlock,
    checkRewrittenBrief, checkCarriedFields, describeBriefFindings,
    declaredSetAllowance, checkDeclaredSet, partitionAnchoredObjects,
    normalizeCitedHandles, carryParentObjects,
    renderEvaluatorReasoning, renderFixTargetLines, renderParentWornState,
  } = require('./iterateBeat');
  // The corrective loop itself is shared with the authored-brief path — one
  // payload contract, one introduced-vs-survived verdict, one model name.
  const { correctFindings, renderCorrectionRequest } = require('./briefCorrection');
  const planLine = resolvePlanLine(currentScene, savedScene);
  if (!planLine) {
    log.warn(`⚠️ [ITERATE] Page ${pageNumber}: no stored plan line (outlineExtract) — the rewrite runs on the previous brief alone`);
  }
  // Named non-roster figures staged on the page. They are cast, and the locked
  // list below is roster-only by construction, so they are carried separately
  // and named — a figure that reaches the rewriter only through the bulk
  // recurring-elements dump comes back described by species.
  const stagedFigures = collectStagedFigures({ visualBible, sceneMetadata, savedScene, planLine, pageNumber });
  if (stagedFigures.length > 0) {
    log.info(`🔄 [ITERATE] Page ${pageNumber}: staged non-roster figures: ${stagedFigures.map(f => `${f.name} (${f.id})`).join(', ')}`);
  }

  // Strict mode: lock cast to the original scene's characters so iterate can't
  // drop/swap them. Free mode: pass the full roster so iterate can reframe.
  let promptCharacters = characters;
  if (!freeIterate) {
    const originalSceneCharNames = (() => {
      try {
        const meta = sceneMetadata?.characters;
        if (Array.isArray(meta) && meta.length > 0) {
          return meta.map(c => String(c?.name || '').trim()).filter(Boolean);
        }
      } catch { /* fall through */ }
      return null;
    })();
    // RESOLVE: lock the cast by ENTRY, not by a lowercased string compare.
    const lockIdx = buildCastIndex({ characters: characters || [] }, visualBible);
    const lockWanted = originalSceneCharNames
      ? new Set(originalSceneCharNames
          .map(n => resolveEntity(n, lockIdx, { log, pageLabel: `P${pageNumber} ` }))
          .filter(e => e && e.kind === 'cast')
          .map(e => e.entry))
      : null;
    const lockedCast = lockWanted ? characters.filter(c => lockWanted.has(c)) : characters;
    if (originalSceneCharNames && lockedCast.length !== originalSceneCharNames.length) {
      log.warn(`🔄 [ITERATE] Page ${pageNumber}: Locked cast resolved ${lockedCast.length}/${originalSceneCharNames.length} from original scene metadata`);
    } else if (originalSceneCharNames) {
      log.info(`🔄 [ITERATE] Page ${pageNumber}: Locked cast to original scene (${lockedCast.length} chars: ${lockedCast.map(c => c.name).join(', ')})`);
    }
    // A REINSTATED FIGURE ARRIVES WITH ITS SHEET (2026-09-17, staging
    // job_1789584708605_rts4wqupm p10). The lock above is the PARENT BRIEF's
    // cast, and template rule 3a lets the rewrite bring back a roster character
    // the plan line stages that the brief had dropped -- so the one figure the
    // rewriter is invited to add is the one whose CHARACTER DETAILS entry the
    // lock withholds. Step 2 then asks it to weave that character's appearance
    // "from CHARACTER DETAILS" with nothing there to weave, and it wrote the
    // template's own apparent-age example instead: a 4-year-old shipped as a
    // bearded middle-aged man. `collectStagedFigures` already does exactly this
    // for the non-roster pool; this is the roster half of the same job, and it
    // only OFFERS the sheet -- rule 3a still decides who is in the frame.
    const planLineCast = collectPlanLineCast({ characters, planLine, alreadyLocked: lockedCast });
    if (planLineCast.length > 0) {
      log.info(`🔄 [ITERATE] Page ${pageNumber}: plan line stages ${planLineCast.map(c => c.name).join(', ')} — the previous brief dropped them, so their character details ride along with the locked cast`);
    }
    promptCharacters = [...lockedCast, ...planLineCast];
  }

  // Step 3: Build the scene description prompt with preview feedback
  // Per-scene textInImage gates the overlay-only rules in scene-iteration.txt
  // / scene-iteration-free.txt. Pulled from storyData.sceneImages (preserved
  // by the unified pipeline at server.js:5980), falling back to story-level
  // layout. Defaults false so non-overlay stories never carry calm-zone
  // instructions through iterate.
  // A cover always carries its text in the image.
  const iterateTextInImage = coverKey ? true : (
    storyData?.sceneImages?.find(s => s.pageNumber === pageNumber)?.textInImage
    ?? storyData?.layout?.textInImage
    ?? false
  ) === true;
  const scenePrompt = buildSceneDescriptionPrompt(
    pageNumber,
    pageText,
    promptCharacters,
    shortSceneDesc,
    language,
    visualBible,
    previousScenes,
    expectedClothing,
    '',  // No correction notes for iteration
    availableAvatars,
    // rawOutlineContext — the page's plan line. NEVER `null` here again: with a
    // null, buildSceneDescriptionPrompt fills the authoritative SCENE_SUMMARY
    // slot from the previous brief's own imageSummary, and the rewrite has no
    // narrative anchor outside the artefact it is rewriting.
    { planLine },
    previewFeedback,  // The actual image analysis feedback!
    // clothingRequirements so the EXPECTED_CLOTHING block can state each
    // character's actual outfit TEXT. Without it the Art Director only sees the
    // category key and writes it into the prose ("wearing her standard clothes"),
    // which the evaluator then judges the render against.
    {
      freeIterate, textInImage: iterateTextInImage, extraRule: options.sceneExtraRule || null, clothingRequirements,
      stagedFigures: renderStagedFiguresBlock(stagedFigures),
      // THE STORY, for the two page facts the Art Director is given and the
      // rewriter was not: the book's SEASON and the creature-tone band. A
      // rewrite authors a whole new setting paragraph and `emptyScenePrompt`,
      // so a season it is never told is a season it can contradict.
      story: storyData,
      // WHY THE PAGE SCORED WHAT IT SCORED. `evaluationFeedback.reasoning` has
      // been handed to this function by the repair pipeline all along and read
      // by nothing: the rewriter got a score and a list of findings and was
      // asked to "name the root cause" of each with no sight of the evaluator's
      // own figure-by-figure inventory. Same for the regions it named.
      evaluatorReasoning: renderEvaluatorReasoning(evaluationFeedback),
      fixTargets: renderFixTargetLines(evaluationFeedback, optionFixTargets),
      // THE WORN STATE THE PAGE ALREADY DECLARED, rendered by the SAME builder
      // the image prompt uses (wornItems.buildWornStateLines) so the rewriter
      // and the illustrator read one sentence. Measured on staging
      // job_1789584708605_rts4wqupm p16: the parent brief declared the jacket
      // OFF and held as a bundle, the rewrite declared nothing, and the built
      // image prompt flipped to "Levin IS wearing this".
      wornState: renderParentWornState({ visualBible, promptCharacters, parentSceneMetadata, pageNumber }),
    }
  );

  // Step 4: Call Claude to run 18 checks and generate corrected scene (uses iteration model).
  // Output is prose paragraph + ---METADATA--- + JSON block (same shape as initial expansion,
  // plus the iterate-specific `previewMismatches`, `checks`, `issues`, `corrections`,
  // `draftValidation` fields inside the metadata JSON). No JSON prefill — the response starts
  // with the prose directly.
  // Default (CONFIG_DEFAULTS.sceneIteration = qwen-plus) is key-guarded to
  // sonnet when OPENROUTER_API_KEY is unset; explicit overrides pass through.
  const effectiveSceneModel = modelOverrides?.sceneIterationModel || modelOverrides?.sceneModel || require('../config/models').resolveSceneIterationModel();
  log.info(`🔄 [ITERATE] Page ${pageNumber}: Running 18 validation checks with ${effectiveSceneModel}...`);
  let sceneResult = await callClaudeAPI(scenePrompt, null, effectiveSceneModel, { usageLabel: 'scene_iterate' });
  let newSceneDescription = sceneResult.text;
  require('./evalCallLog').recordEvalCall({
    kind: 'iterate_rebrief', pageNumber, model: sceneResult.modelId || effectiveSceneModel, prompt: scenePrompt, rawResponse: sceneResult.text,
  });

  // Track usage (Claude Haiku scene re-expansion)
  if (usageTracker && sceneResult.usage) {
    usageTracker('anthropic', sceneResult.usage, 'scene_iterate', sceneResult.modelId || effectiveSceneModel);
  }

  // ENFORCE THE BRIEF CONTRACT: prose plus scene metadata that PARSES and
  // carries sceneIntent (the marker, a ```json fence and bare JSON are all
  // accepted — see iterateBriefGuard.js, all three shapes are real in stored
  // rows). A reply that fails it is a CUT reply, not a shorter one — and a
  // cut brief used to be persisted silently: job_1789207854566_l43qgl34w p7
  // stored 1884 characters ending mid-word inside a character description with
  // no metadata block at all, so the page's cast, objects, positions and text
  // placement were all empty downstream and the roster shipped wrong. The
  // generic truncation guard cannot see it (~500 output tokens against
  // qwen-plus's 32,768 ceiling), so the detection is structural
  // (iterateBriefGuard.js) and the guard's verdict is consulted alongside it.
  // One retry; still unusable → THROW, so the round is recorded as failed and
  // the previous good brief and image stand. Never overwrite good with cut.
  const { assessIterateBrief, describeIterateBrief } = require('./iterateBriefGuard');
  let briefCheck = assessIterateBrief(newSceneDescription, { truncation: sceneResult.truncation });
  if (!briefCheck.usable) {
    log.warn(`⚠️ [ITERATE] Page ${pageNumber}: scene iteration returned an unusable brief (${describeIterateBrief(briefCheck)}) — retrying once`);
    const retryPrompt = `${scenePrompt}\n\nYour previous answer was incomplete: it must be the full prose brief followed by a ---METADATA--- block whose JSON includes the mandatory "sceneIntent" field. Return the whole thing.`;
    const retry = await callClaudeAPI(retryPrompt, null, effectiveSceneModel, { usageLabel: 'scene_iterate_retry' });
    if (usageTracker && retry.usage) {
      usageTracker('anthropic', retry.usage, 'scene_iterate', retry.modelId || effectiveSceneModel);
    }
    require('./evalCallLog').recordEvalCall({
      kind: 'iterate_rebrief', label: 'retry', pageNumber, model: retry.modelId || effectiveSceneModel,
      prompt: retryPrompt, rawResponse: retry.text,
    });
    const retryCheck = assessIterateBrief(retry.text, { truncation: retry.truncation });
    if (retryCheck.usable) {
      sceneResult = retry;
      newSceneDescription = retry.text;
      briefCheck = retryCheck;
    } else {
      log.error(`❌ [ITERATE] Page ${pageNumber}: unusable brief after retry (first: ${describeIterateBrief(briefCheck)}; retry: ${describeIterateBrief(retryCheck)}) — REFUSING to overwrite the existing brief; this iterate round fails for this page`);
      throw new Error(`iterate brief unusable for page ${pageNumber}: ${describeIterateBrief(retryCheck)}`);
    }
  }

  // THE REINSTATEMENT BACKSTOP (owner, 2026-09-14). The rewriter now receives
  // the page's beat, so it can bring back a figure the previous brief had
  // trimmed. The semantic judge builds its expected roster from the brief's own
  // `characters[]` / `objects[]` (buildExpectedCastBlock) and never from a plan
  // line — commit 3b3070dce, which stands. A figure reinstated in the PROSE
  // ALONE therefore renders as an extra character and is scored as one. The
  // prompt states the rule; this verifies it happened, reusing the same
  // sceneBriefCheck types the first-generation path already runs
  // (cast_unlisted — and, until 2026-09-18, element_uncited) with the page's
  // plan line set — the owner-sanctioned non-fidelity use of the beat.
  //
  // One corrective re-ask, then ship with a warning: a gate is a guideline and
  // an iterate round is paid, so this never fails the round.
  // Same roster the first-generation path checks against: main cast plus
  // visual-bible SECONDARY characters, animals deliberately excluded (owner,
  // 2026-08-16 — beatsPipeline.js:1955 carries the measurement). A named animal
  // was covered by element_uncited through the plan line until that check was
  // removed on 2026-09-18 (it classified by matching prose; see
  // sceneBriefCheck's design block). A reinstated ANIMAL cited nowhere is
  // therefore unguarded on this path — tasks/BACKLOG.md carries it.
  const castNamesForCheck = (() => {
    const secondaries = Array.isArray(visualBible?.secondaryCharacters)
      ? visualBible.secondaryCharacters
      : Object.values(visualBible?.secondaryCharacters || {});
    const seen = new Set();
    return [...(characters || []), ...secondaries]
      .map(c => String(c?.name || '').trim())
      .filter(n => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
  })();
  // THE REWRITE IS CHECKED LIKE AN AUTHORED BRIEF (2026-09-17). Until now the
  // filter above kept two of the eleven fault types `checkPage` computes, so a
  // rewrite could ship a page the scene review would have sent back: a citation
  // the bible's page table does not grant, an element the table claims and the
  // rewrite stopped citing, two declared actions on a one-action pipeline. The
  // parent brief is checked in the same breath, and only faults the parent was
  // FREE of reach the re-ask — a rewrite inherits the bible and cannot be asked
  // to fix what it was handed. Plus the metadata half of the same subtraction:
  // 11 of 11 stored rewrites returned depth / looksAt / action on no row at
  // all, which does not merely lose those fields, it silently switches the
  // one-action and hand-off counts off. Both checks are free — pure code, no
  // model call — and both feed the ONE corrective re-ask below, never a second.
  const runBriefChecks = (text) => [
    ...checkRewrittenBrief({
      pageNumber, brief: text, parentBrief: sceneDescText, planLine, castNames: castNamesForCheck, visualBible,
    }),
    ...checkCarriedFields({
      // The parent BRIEF's own metadata: it is the contract this rewrite
      // replaces, and it always parses to the full row shape. (savedScene's
      // stored copy flattens `characters` to a name list on some paths, and a
      // flattened list would read as "never declared".)
      parentMetadata: sceneMetadata,
      rewriteMetadata: extractSceneMetadata(String(text || '')),
    }),
  ];
  // ── ONE CORRECTIVE RE-ASK, FOR BOTH CHECK FAMILIES (2026-09-17) ───────────
  // Owner: "All 3 same as pipeline. These should be siblings or even identical
  // code." Two hand-rolled re-asks stood here — one for the declaration checks
  // above, one for the declared set — and MEASURED over the 11 stored iterate
  // rounds of staging job_1789584708605_rts4wqupm and
  // job_1789506283204_3kxqshifx neither resolved anything on any page: each
  // fired once, the count never fell, so the original was kept every time and
  // every page shipped with a WARN. Detection worked; correction never landed.
  // Three defects, all of them now answered in server/lib/briefCorrection.js,
  // which the authored path reads from the same file:
  //   - the corrector was sent the ORIGINAL prompt and never the answer it was
  //     asked to revise, which is a re-roll, not a correction
  //     (renderCorrectionRequest + assertCorrectorSeesText),
  //   - acceptance was `after.length < before.length`, which scores a swap of
  //     one fault for another as EQUAL and rejects it, and never asks WHICH
  //     faults moved (judgeCorrection: introduced vs survived),
  //   - the corrector was `sceneIteration`, the model that had just failed the
  //     contract (MODEL_DEFAULTS.briefCorrectionModel).
  //
  // The two families are checked together and answered in ONE call. The
  // declared set never depended on the declaration re-ask's output, and judging
  // a correction on the UNION is what the second re-ask's hand-rolled
  // cross-guard was reaching for: a correction that resolves one family by
  // breaching the other introduces a finding, and an introduced finding is
  // REPORTED, not a refusal — that refusal branch was deleted on 2026-09-18
  // (74bcaa79e; briefCorrection.judgeCorrection, and docs/decisions.md "A brief
  // correction is never refused for a finding it newly REPORTS"). `strict` now
  // refuses only a correction that resolves nothing.
  //
  // THE DECLARED SET (2026-09-16): objects[] / characters[] may cite only
  // original ∪ plan-line ∪ feedback. Measured on job_1789506283204_3kxqshifx,
  // three of five rewrites cited a landmark or a creature none of their inputs
  // named, and each invented citation became a critical on content that had
  // been correct. The allowance is computed per CANDIDATE, because part of it
  // ("an id this answer cites that the feedback names") is a property of the
  // answer being judged, not of the first one.
  const origObjects = (parentSceneMetadata.objects || parentSceneMetadata.fullData?.objects || []);
  // ...and the SAME set in the other direction (2026-09-17). Zero additions
  // occurred on job_1789584708605_rts4wqupm; SUBTRACTION did the damage -- p6
  // and p16 both stopped citing the artefact their page is about, and p16's
  // REQUIRED OBJECTS block shipped as a header with no entries. `nameIds` lets
  // a named figure's NAME in `characters[]` satisfy its id: that is a refile,
  // not a loss (p13 moved CHR001 to "Ramon" on the same run).
  const declaredSetNameIds = (() => {
    const map = {};
    const secondaries = Array.isArray(visualBible?.secondaryCharacters)
      ? visualBible.secondaryCharacters
      : Object.values(visualBible?.secondaryCharacters || {});
    for (const e of [...secondaries, ...(visualBible?.animals || [])]) {
      if (e?.name && e?.id) map[String(e.name).trim()] = String(e.id);
    }
    return map;
  })();
  const runDeclaredSetCheck = (text) => {
    const meta = extractSceneMetadata(String(text || ''));
    const args = declaredSetAllowance({
      origObjects,
      rewriteObjects: meta?.objects,
      evaluationFeedback, pageText, planLine,
      origCharacters: parentSceneMetadata.characters,
      promptCharacters,
      stagedFigures,
    });
    args.requiredObjects = origObjects;
    args.nameIds = declaredSetNameIds;
    return checkDeclaredSet({ newMetadata: meta, ...args });
  };
  const runAllBriefChecks = (text) => [...runBriefChecks(text), ...runDeclaredSetCheck(text)];

  let briefFindings = runAllBriefChecks(newSceneDescription);
  if (briefFindings.length > 0) {
    log.warn(`⚠️ [ITERATE] Page ${pageNumber}: rewritten brief fails a check an authored brief is held to:\n${describeBriefFindings(briefFindings)}`);
    const correctionModel = modelOverrides?.briefCorrectionModel || require('../config/models').resolveBriefCorrectionModel();
    let correctionResult = null;
    // ONE CORRECTIVE RE-ASK, THEN SHIP FLAGGED. The comment above the old
    // re-asks claimed this ("a gate is a guideline and an iterate round is
    // paid, so this never fails the round") and the code did not implement it:
    // a provider error inside the re-ask threw straight out of iteratePageCore
    // and destroyed the whole paid round. The correction is an improvement on
    // a brief that already exists, so its failure costs the improvement and
    // nothing else.
    const correction = await correctFindings({
      label: `iterate page ${pageNumber}`,
      priorText: newSceneDescription,
      before: briefFindings,
      payload: renderCorrectionRequest({
        context: scenePrompt,
        priorText: newSceneDescription,
        findingsText: describeBriefFindings(briefFindings),
        instruction: 'Return the whole brief again. Keep the same moment and the same fixes, and resolve each line above: declare a figure in the picture (a person in "characters[]" by name, a staged animal or secondary figure in "objects[]" by its id) or take it out of the prose; cite an element the page stages and drop a citation the page does not; cite only the objects and characters the previous brief, the plan line and the feedback name, and keep citing every id the previous brief cited, either in "objects[]" or, for a named figure, by name in "characters[]"; state every field the metadata contract requires on every row. Change nothing else — a line above resolved by breaking another is not a fix.',
      }),
      invoke: async (payload) => {
        const r = await callClaudeAPI(payload, null, correctionModel, { usageLabel: 'scene_iterate_correct' });
        if (usageTracker && r.usage) {
          usageTracker('anthropic', r.usage, 'scene_iterate', r.modelId || correctionModel);
        }
        const g = assessIterateBrief(r.text, { truncation: r.truncation });
        correctionResult = r;
        return { text: r.text, usable: g.usable, usage: r.usage, reason: g.usable ? null : describeIterateBrief(g) };
      },
      recheck: runAllBriefChecks,
    }).catch((err) => {
      log.error(`❌ [ITERATE] Page ${pageNumber}: the corrective re-ask failed (${err.message}) — the rewrite stands and ships flagged`);
      return { accepted: false };
    });
    if (correction.accepted) {
      if (correctionResult) sceneResult = correctionResult;
      newSceneDescription = correction.text;
      briefFindings = correction.after;
    }
    if (briefFindings.length > 0) {
      log.error(`❌ [ITERATE] Page ${pageNumber}: shipping a rewrite that fails a check an authored brief is held to:\n${describeBriefFindings(briefFindings)}`);
    }
  }

  // Extract previewMismatches + checks from the metadata JSON block. parseProseMetadataFormat
  // splits on ---METADATA--- and parses the JSON — the fields live alongside scene structure.
  let previewMismatches = [];
  let checksRun = {};
  try {
    const parsed = parseProseMetadataFormat(newSceneDescription);
    if (parsed?.metadata) {
      previewMismatches = parsed.metadata.previewMismatches || [];
      checksRun = parsed.metadata.checks || parsed.metadata.selfCritique || {};
      log.info(`🔄 [ITERATE] Page ${pageNumber}: Found ${previewMismatches.length} mismatches: ${JSON.stringify(previewMismatches)}`);
    } else {
      log.warn(`🔄 [ITERATE] Page ${pageNumber}: Could not parse prose+metadata format — mismatches/checks unavailable`);
    }
  } catch (parseErr) {
    log.warn(`🔄 [ITERATE] Could not extract mismatches from prose+metadata: ${parseErr.message}`);
  }

  // Step 5: Prepare for image generation
  //
  // THE REWRITE'S LIST IS THE CAST (owner decision 2026-09-23). A rewrite whose
  // metadata carries a `characters` array has said who is in the picture —
  // empty, or creatures only, means no photo-backed people, and no name scan
  // runs (castOfRewrittenBrief). Staging job_1790100385959_1nitlympp p17: the
  // name scan found four absent boys in a garment line and a diagnosis line, and
  // the page was rendered with their references and judged against them.
  // A rewrite with NO characters array cannot reach this line: every metadata
  // parser that yields a usable brief requires the key, and the prose-only
  // recovery carries no sceneIntent, so assessIterateBrief refused it above.
  // Reaching here without one is a contract break, never a cue to guess.
  const sceneCharacters = castOfRewrittenBrief(newSceneDescription, characters);
  if (sceneCharacters === null) {
    throw new Error(`[ITERATE] Page ${pageNumber}: the rewrite passed the brief guard but declares no characters array — refusing to derive a cast from the brief text`);
  }

  // Extract metadata from the new scene description for per-character clothing
  let newSceneMetadata = extractSceneMetadata(newSceneDescription);

  // ANCHORED OBJECT ALLOW-LIST (owner decision 2026-07-18). The rule, its
  // page-range gate and the measurements live on
  // iterateBeat.partitionAnchoredObjects, beside collectStagedFigures — the two
  // sites that put a Visual Bible entity on a page, pinned together by the
  // `iterate-page-staging-sites` sibling-registry set. This site only applies
  // the verdict to the brief.
  const { kept, scrubbed } = partitionAnchoredObjects({
    rewriteObjects: newSceneMetadata?.objects, origObjects, evaluationFeedback, pageText, planLine, visualBible, pageNumber,
  });
  if (scrubbed.length > 0) {
    log.warn(`⚠️ [ITERATE] Page ${pageNumber}: rewrite added unanchored VB object(s) ${JSON.stringify(scrubbed)} — scrubbed (not in original metadata, feedback, page text or plan line)`);
    const objRe = /"objects"\s*:\s*\[[^\]]*\]/;
    if (objRe.test(newSceneDescription)) {
      newSceneDescription = newSceneDescription.replace(objRe, `"objects": ${JSON.stringify(kept)}`);
      newSceneMetadata = extractSceneMetadata(newSceneDescription);
    }
  }

  // THE PARENT'S CITATIONS ARE CARRIED FORWARD, THEN EVERY CITED HANDLE IS
  // CHECKED AGAINST THE BIBLE.
  //
  //  - Every Visual Bible id the parent brief cited and the rewrite's
  //    `objects[]` no longer holds comes back (iterateBeat.carryParentObjects,
  //    2026-09-23). Staging job_1790100385959_1nitlympp p17: the rewrite moved
  //    both creatures into `characters[]` by name, which the prompt's REQUIRED
  //    OBJECTS block does not read, and the hatchling lost its reference cell.
  //    This supersedes the 2026-09-17 restore, which fired only when the
  //    rewrite's list resolved to nothing printable (p6 and p16 of staging
  //    job_1789584708605_rts4wqupm lost the egg their page is about).
  //  - A facet suffix on an entry that has no such facet, or whose facet covers
  //    no page, is reduced to the bare parent id (2026-09-17, same run: five of
  //    six rewrites appended one, e.g. `LOC001.1` on a location with an EMPTY
  //    `vantages[]`, and every consumer silently fell back to the parent or to
  //    `.1`). It runs AFTER the carry so a carried handle is checked too.
  //
  // Structured throughout -- ids, pools and facet arrays, never a text match.
  // Both rules rewrite the SAME `objects[]` array in the brief, through the one
  // replacement the scrub above uses, so the stored brief and the metadata the
  // prompt is built from can never disagree.
  {
    const objRe = /"objects"\s*:\s*\[[^\]]*\]/;
    const applyObjects = (list) => {
      if (!objRe.test(newSceneDescription)) return false;
      newSceneDescription = newSceneDescription.replace(objRe, `"objects": ${JSON.stringify(list)}`);
      newSceneMetadata = extractSceneMetadata(newSceneDescription);
      return true;
    };
    const carry = carryParentObjects({ rewriteObjects: newSceneMetadata?.objects, parentObjects: origObjects });
    if (carry.carried.length > 0) {
      if (applyObjects(carry.objects)) {
        log.warn(`⚠️ [ITERATE] Page ${pageNumber}: the rewrite's objects[] no longer cites ${carry.carried.join(', ')} — carried forward from the parent brief`);
      } else {
        log.error(`❌ [ITERATE] Page ${pageNumber}: the rewrite dropped ${carry.carried.join(', ')} and its metadata has no "objects" array to carry them into — the page renders without them`);
      }
    }
    const normalized = normalizeCitedHandles({ objects: newSceneMetadata?.objects, visualBible });
    if (normalized.rejected.length > 0) {
      log.warn(`⚠️ [ITERATE] Page ${pageNumber}: rewrite cited facet(s) the Visual Bible does not declare — `
        + `${normalized.rejected.map(r => `${r.handle} (${r.reason})`).join(', ')} — reduced to the bare id`);
      applyObjects(normalized.objects);
    }
  }

  // THE DECLARED LIGHT IS CARRIED FORWARD (2026-09-24, sceneLight.js). A
  // rewrite that states no `timeOfDay` / `weather` keeps the parent brief's, in
  // the brief text itself, so the page prompt's LIGHT line, the stored brief
  // the judges read and the next rewrite all see it. A rewrite that states a
  // value wins. Loud: the omission is logged.
  {
    const { carryForwardLightInBrief } = require('./sceneLight');
    const lightCarry = carryForwardLightInBrief(newSceneDescription, parentSceneMetadata);
    if (lightCarry) {
      log.warn(`🌗 [ITERATE] Page ${pageNumber}: the rewrite dropped ${lightCarry.carried.join(' and ')} — carried forward from the parent brief`);
      newSceneDescription = lightCarry.brief;
      newSceneMetadata = extractSceneMetadata(newSceneDescription);
    }
  }

  // A REWRITE THAT DROPS A CITED VB ID MUST SAY SO (2026-09-14, story B
  // job_1789343124794_z2c779f7i p17). The `iterate-round-1` rewrite there —
  // commissioned for a hammer artefact, a facing error and stray leaves —
  // silently stopped citing ANI001/ANI002, and the shipped v1 prompt lost both
  // size riders and the ANI reference cell with nothing logged. The union
  // resolution in promptBuilders (objects[] ∪ characters[]) makes the
  // reclassification harmless; this says it out loud when a citation is gone
  // outright. LOG-ONLY — a gate is a guideline: the rewrite stands, the round
  // is not failed.
  try {
    const { warnDroppedVbCitations } = require('./storyHelpers');
    warnDroppedVbCitations(
      pageNumber,
      parentSceneMetadata,
      newSceneMetadata || {},
      { what: 'iterate rewrite' }
    );
  } catch (e) {
    log.warn(`⚠️ [VB-CITATION] Page ${pageNumber}: citation-drop check could not run — ${e.message}`);
  }

// Resolve clothing. The stored pageClothing was set by the unified Sonnet
  // call at generation time and reflects the canonical per-page costume
  // decision — if it says costumed:mittelalterlich for this page, the Haiku
  // iterate call must not downgrade it to standard. So: when the stored
  // pageClothing has any costumed entry, it wins. Otherwise fall back to
  // Claude's iterate output (for pages that legitimately change clothing
  // mid-story).
  let clothingCategory;
  let effectiveClothingRequirements = clothingRequirements;

  const storedPageClothing = coverKey ? (coverRecord.perCharClothing || null) : pageClothingData?.pageClothing?.[pageNumber];
  // Normalize string form ("costumed:mittelalterlich" applied page-wide) into per-character
  // map so the override below catches both string and object input shapes.
  const storedPageClothingMap = (() => {
    if (!storedPageClothing) return null;
    if (typeof storedPageClothing === 'object') return storedPageClothing;
    if (typeof storedPageClothing === 'string') {
      return Object.fromEntries(sceneCharacters.map(c => [c.name, storedPageClothing]));
    }
    return null;
  })();
  const storedHasCostumed = storedPageClothingMap
    ? Object.values(storedPageClothingMap).some(v => typeof v === 'string' && v.startsWith('costumed'))
    : false;

  if (storedHasCostumed && storedPageClothingMap) {
    const perPageClothing = convertClothingToCurrentFormat(storedPageClothingMap);
    effectiveClothingRequirements = { ...clothingRequirements };
    for (const [charName, charClothing] of Object.entries(perPageClothing)) {
      effectiveClothingRequirements[charName] = {
        ...effectiveClothingRequirements[charName],
        ...charClothing
      };
    }
    const clothingValues = Object.values(storedPageClothingMap);
    const firstClothing = clothingValues[0];
    if (!firstClothing) {
      // NO DEFAULT (owner, 2026-08-07): an empty clothing map means nothing
      // on this page says what anyone wears; 'standard' would resolve to a
      // wardrobe from an unrelated story.
      throw new Error(`[ITERATE] Page ${pageNumber}: clothing map is empty. Refusing to default to 'standard'.`);
    }
    clothingCategory = firstClothing;
    const iterateCh = newSceneMetadata?.characterClothing || null;
    if (iterateCh && Object.values(iterateCh).some(v => !String(v).startsWith('costumed'))) {
      log.warn(`⚠️ [ITERATE] Page ${pageNumber}: Haiku tried to downgrade clothing to ${JSON.stringify(iterateCh)} — overriding with stored pageClothing ${JSON.stringify(storedPageClothing)}`);
    } else {
      log.debug(`🔄 [ITERATE] Using stored pageClothing (authoritative costumed): ${JSON.stringify(storedPageClothing)}`);
    }
  } else if (newSceneMetadata?.characterClothing && Object.keys(newSceneMetadata.characterClothing).length > 0) {
    // Priority 1: Per-character clothing from newly generated scene description
    const sceneClothing = newSceneMetadata.characterClothing;
    const perCharClothing = convertClothingToCurrentFormat(sceneClothing);
    effectiveClothingRequirements = { ...clothingRequirements };
    for (const [charName, charClothing] of Object.entries(perCharClothing)) {
      effectiveClothingRequirements[charName] = {
        ...effectiveClothingRequirements[charName],
        ...charClothing
      };
    }
    const clothingValues = Object.values(sceneClothing);
    const firstClothing = clothingValues[0];
    if (!firstClothing) {
      // NO DEFAULT (owner, 2026-08-07): an empty clothing map means nothing
      // on this page says what anyone wears; 'standard' would resolve to a
      // wardrobe from an unrelated story.
      throw new Error(`[ITERATE] Page ${pageNumber}: clothing map is empty. Refusing to default to 'standard'.`);
    }
    clothingCategory = firstClothing;
    log.debug(`🔄 [ITERATE] Using per-character clothing from scene description: ${JSON.stringify(sceneClothing)}`);
  } else {
    // Priority 2: Per-character clothing from pageClothing (stored data)
    const pageClothingEntry = storedPageClothing;
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
      if (!firstClothing) {
      // NO DEFAULT (owner, 2026-08-07): an empty clothing map means nothing
      // on this page says what anyone wears; 'standard' would resolve to a
      // wardrobe from an unrelated story.
      throw new Error(`[ITERATE] Page ${pageNumber}: clothing map is empty. Refusing to default to 'standard'.`);
    }
    clothingCategory = firstClothing;
      log.debug(`🔄 [ITERATE] Using per-character clothing from pageClothing: ${JSON.stringify(pageClothingEntry)}`);
    } else {
      // NO DEFAULT CLOTHING (owner, 2026-08-07). Reaching here means the page
      // has no stored clothing, the rewrite named none, and the story has no
      // primary category — there is nothing to dress this page from except a
      // guess, and a guessed category resolves to the character-level avatars
      // wardrobe, i.e. an outfit from an unrelated story.
      clothingCategory = parseClothingCategory(newSceneDescription) || pageClothingData?.primaryClothing;
      if (!clothingCategory) {
        throw new Error(`[ITERATE] Page ${pageNumber}: no clothing category from pageClothing, the rewrite, or the story's primaryClothing. Refusing to fall back to 'standard'.`);
      }
    }
  }

  let referencePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory, artStyle, effectiveClothingRequirements);

  // Apply styled avatars (skip when all already styled or costumed)
  const allAlreadyStyled = referencePhotos.every(p =>
    p.photoType?.startsWith('styled-') || p.photoType?.startsWith('costumed-')
  );
  if (!allAlreadyStyled && (!clothingCategory || !clothingCategory.startsWith('costumed'))) {
    referencePhotos = applyStyledAvatars(referencePhotos, artStyle);
  }

  // Phase 3b: optionally replace each character's full-image styled-avatar
  // reference with a single body cell cropped out of the story-scoped 2×4
  // sheet at story.data.characterAvatars[name][slotKey]. Pose comes from
  // scene-expansion metadata so the cell matches the figure's intended
  // facing direction on this page. Skips characters with no story sheet.
  if (useStorySheetCells && storyData?.characterAvatars) {
    const { cropAvatarCell } = require('./sceneComposite');
    const metaChars = newSceneMetadata?.fullData?.characters
      || newSceneMetadata?.characters
      || sceneCharacters
      || [];
    // Pose + depth resolution is shared with applyStoryCellRefs — beats
    // metadata carries `perspective` prose, not `pose`, and the inline copy
    // here served threeQuarter to every declared back-view figure.
    const { resolveCellPose, resolveSheetForRef, wornResolvedForPage } = require('./storyAvatars');
    // WARDROBE STATE ON A REWRITTEN PAGE. scene-iteration.txt emits no
    // `wornItems`, so the rewrite's own metadata says nothing about what this
    // page takes off — the carry-forward is the ONLY thing that keeps an
    // iterated page on its off-variant sheet, exactly as it keeps the page's
    // "is NOT wearing this" prompt line (see iterateSceneMetadata below, same
    // rule, same helper).
    const { carryForwardWornItems } = require('./wornItems');
    const wornResolved = wornResolvedForPage(
      storyData?.visualBible || null,
      { ...(newSceneMetadata || {}), wornItems: carryForwardWornItems(newSceneMetadata, parentSceneMetadata || {}) },
      metaChars,
      pageNumber
    );
    const poseByName = new Map();
    for (const sc of metaChars) {
      const nm = (typeof sc === 'string' ? sc : sc?.name) || '';
      if (!nm) continue;
      poseByName.set(nm.toLowerCase(), resolveCellPose(sc));
    }
    for (const ref of referencePhotos) {
      const charName = ref.name;
      if (!charName) continue;
      const story = storyData.characterAvatars[charName];
      if (!story) continue;
      // Shared resolver: slot mapping, the wardrobe-state variant, and the loud
      // costumed fallback (which also corrects ref.clothingCategory) all live in
      // storyAvatars.js. The inline copy here fell back silently.
      const resolved = resolveSheetForRef(story, ref, { wornResolved });
      if (!resolved) continue;
      const { uri: sheetUri, slotKey } = resolved;
      const pf = poseByName.get(charName.toLowerCase()) || { pose: 'threeQuarter', depth: 'foreground' };
      const includeFace = pf.depth === 'foreground';
      try {
        const { body, stacked } = await cropAvatarCell(sheetUri, { pose: pf.pose, includeFace, stack: includeFace });
        const buf = stacked || body;
        ref.photoUrl = `data:image/png;base64,${buf.toString('base64')}`;
        ref.photoType = `cell-${pf.pose}${includeFace ? '-headbody' : ''}`;
        ref.cellPose = pf.pose;
        ref.cellDepth = pf.depth;
        ref.cellIncludesFace = includeFace;
        log.debug(`[CELL REFS] ${charName}: cropped ${pf.pose}${includeFace ? ' + head' : ''} (depth=${pf.depth}) from ${slotKey}`);
      } catch (err) {
        log.warn(`[CELL REFS] crop failed for ${charName}: ${err.message} — falling back to existing ref`);
      }
    }
  }

  // The rewrite's metadata is the working copy, but scene-iteration.txt does
  // not emit `era` or `textZoneDescription` — context fields iterate has no
  // business re-deciding. Read them from the rewrite when present, else from
  // the saved scene, or the anachronism guard and text-zone hint go dark on
  // every repaired page (same disease 6738d7dca fixed for beats pages).
  const savedMeta = parentSceneMetadata;
  const iterateSceneMetadata = {
    ...newSceneMetadata,
    era: newSceneMetadata?.era || savedMeta.era || savedMeta.fullData?.era || null,
    textZoneDescription: newSceneMetadata?.textZoneDescription || savedMeta.textZoneDescription || null,
    aboard: newSceneMetadata?.aboard || savedMeta.aboard || savedMeta.fullData?.aboard || null,
    // Same class as era/textZoneDescription: scene-iteration.txt does not emit
    // the crowd flag, so a repaired page would lose it and its background
    // extras would come back as a derived extra_character.
    // Three states since 2026-09-19 — `population` carries forward for the same
    // reason, and `crowdExpected` stays derived from it so old readers agree.
    population: (() => {
      const { normalisePopulation } = require('./sceneMetadata');
      const raw = newSceneMetadata?.population || savedMeta.population || savedMeta.fullData?.population || null;
      const legacy = newSceneMetadata?.crowdExpected === true
        || savedMeta.crowdExpected === true || savedMeta.fullData?.crowdExpected === true;
      return normalisePopulation(raw, legacy);
    })(),
    crowdExpected: newSceneMetadata?.crowdExpected === true
      || savedMeta.crowdExpected === true || savedMeta.fullData?.crowdExpected === true,
    // MEASURED, NOT DECLARED — and never re-decidable by a rewrite. The
    // plate-derived population is a reading of the page's own empty-scene
    // plate (2026-09-19); scene-iteration.txt neither sees a plate nor emits
    // the field, so it carries forward verbatim or the repaired page loses the
    // evidence and its background extras come back as an extra_character.
    platePopulation: savedMeta.platePopulation || savedMeta.fullData?.platePopulation || null,
    // Same class again: scene-iteration.txt does not emit `wornItems`, and the
    // metadata parser turns an absent field into `[]`. An undeclared row makes
    // resolveWornItemsForPage default the item to `worn`, so an iterated page
    // that had taken an item OFF came back with the affirmative "IS wearing
    // this" override in the prompt and the item painted back on. One rule, in
    // wornItems.carryForwardWornItems.
    wornItems: require('./wornItems').carryForwardWornItems(newSceneMetadata, savedMeta),
    // Same class, two more fields the rewrite may legitimately re-decide and
    // must never silently drop: `shot` drives the background plate's framing,
    // the scale repair's foreground/background split and the reference mode;
    // `landmarkView` picks the landmark reference photo. Both were emitted by
    // the Art Director on every page of both staging runs and by NONE of the 11
    // rewrites. A rewrite that states one wins; a rewrite that is silent keeps
    // the page's own.
    shot: newSceneMetadata?.shot || newSceneMetadata?.fullData?.shot
      || savedMeta.shot || savedMeta.fullData?.shot || null,
    landmarkView: newSceneMetadata?.landmarkView || newSceneMetadata?.fullData?.landmarkView
      || savedMeta.landmarkView || savedMeta.fullData?.landmarkView || null,
  };

  // Build landmark photos — from the MERGED metadata, not the raw rewrite.
  // getLandmarkPhotosForScene reads `landmarkView` to pick the reference photo,
  // and the rewrite emitted none on 11 of 11 stored iterate rounds across two
  // staging runs, so every repaired page chose its landmark photo blind. The
  // merge below is what restores the parent's value; running it first is the
  // whole point. (2026-09-17.)
  const pageLandmarkPhotos = visualBible ? await getLandmarkPhotosForScene(visualBible, iterateSceneMetadata, { pageNumber }) : [];

  // Determine image model and backend (needed before empty scene generation)
  // A page REDO renders on the page tier, not on the edit/inpaint tier. Falling
  // through to null meant generateImageOnly's defaultModel (MODEL_DEFAULTS
  // .pageImage = the edit tier), so an iterate could redo on a different model
  // than the one that produced V1. pageRenderImage is that same page tier.
  let imageModelOverride = modelOverrides?.imageModel || CONFIG_DEFAULTS.pageRenderImage;
  // A cover's own render options — its baked title and the typography-aware
  // model that paints it — one resolver with the generation path (coverRender.js).
  const coverOpts = coverKey
    ? require('./coverRender').coverRenderOptions(pageNumber, {
        title: storyData.title || storyData.storyTitle || '',
        dedication: storyData.dedication || null,
        coverTitleMode: modelOverrides?.coverTitleMode || null,
      })
    : null;
  if (coverOpts?.imageModel) imageModelOverride = coverOpts.imageModel;

  // Route by scene complexity when no explicit model override
  if (!imageModelOverride) {
    const sceneComplexity = iterateSceneMetadata?.sceneComplexity || 'simple';
    if (sceneComplexity === 'complex') {
      imageModelOverride = CONFIG_DEFAULTS.complexPageImage;
      log.info(`🎯 [ITERATE] Page ${pageNumber}: complex scene → ${imageModelOverride}`);
    }
  }

  const iterateImageBackend = imageModelOverride ? (IMAGE_MODELS[imageModelOverride]?.backend || null) : null;

  // Resolve empty scene background (resolveIteratePlate — plate or fail).
  const { sceneBackground, iteratePageRef } = await resolveIteratePlate({
    pageNumber, storyData, visualBible, iterateSceneMetadata, sceneCharacters,
    pageLandmarkPhotos, sceneBackgroundIn, effectiveSinglePass, emptySceneCallbacks,
    lockedTextPosition, sceneAspect, imageModelOverride,
  });

  // Build VB grid — when sceneBackground is set, vehicles/large structures/landmarks are
  // already painted into the empty scene plate, so drop them from the composite refs.
  const pageRefs = visualBible
    ? await buildPageCompositeRefs(visualBible, pageNumber, pageLandmarkPhotos, {
        hasBackground: !!sceneBackground,
        logTag: 'ITERATE',
        // Keep the grid in step with what the page prompt describes — the
        // prompt is built from the scene's objects[], so a prop named there
        // must bring its reference even if the VB filed it under other pages.
        sceneObjectIds: iterateSceneMetadata?.objects || null,
        // Same aboard rule as the plate and the pipeline page grid: the vessel
        // the camera stands on never rides in as an exterior render.
        aboardId: iterateSceneMetadata?.aboard || null,
        // Same worn-item dedupe as the first-generation grid — a repair must
        // not reintroduce the duplicate plate the page render dropped.
        sceneMetadata: iterateSceneMetadata || null,
      })
    : { visualBibleGrid: null, landmarkPhotos: pageLandmarkPhotos };
  const visualBibleGrid = pageRefs.visualBibleGrid;
  const finalLandmarkPhotos = pageRefs.landmarkPhotos;

  // The iterate output is prose + ---METADATA--- + JSON (same shape as initial
  // expansion). buildImagePrompt's prose branch strips the metadata block and
  // uses only the prose for the image prompt — no JSON-scene extraction needed.
  let imagePrompt = buildImagePrompt(newSceneDescription, storyData, sceneCharacters, visualBible, pageNumber, referencePhotos, {
    imageBackend: iterateImageBackend,
    textPositionOverride: lockedTextPosition,
    // Grid is already built above — pass exactly the elements it contains so
    // the REQUIRED OBJECTS checklist can point at the attached references.
    vbRefElementIds: (visualBibleGrid?.rawElements || []).map(e => e.id).filter(Boolean),
  });
  // A baked front cover's REQUIRED TEXT block, at the prompt's absolute end —
  // the same tail the generation path appends.
  if (coverOpts?.bakeTitle) imagePrompt = getStoryHelpers().withBakedTitle(imagePrompt, coverOpts.bakeTitle);

  // Eval feedback was already routed to Claude via previewFeedback.fixIssues
  // (see Step 2 above). The image API gets a prose-only prompt — it cannot
  // reason about evaluator bullets, and stacking them on the prose led to
  // cherry-picking and prompt-leak text artifacts.
  if (evaluationFeedback?.fixableIssues?.length > 0) {
    log.info(`🔄 [ITERATE] Page ${pageNumber}: ${evaluationFeedback.fixableIssues.length} eval bullets routed to scene re-expansion (score: ${evaluationFeedback.score ?? 'N/A'})`);
  }

  // Preview mode: return prompt + mismatches without generating image
  if (previewOnly) {
    log.info(`🔄 [ITERATE] Page ${pageNumber}: Preview mode — returning prompt only (${imagePrompt.length} chars)`);
    return {
      previewOnly: true,
      imagePrompt,
      newScene: newSceneDescription,
      newSceneMetadata,
      compositionAnalysis: previewFeedback.composition,
      previewMismatches,
      checksRun,
      method: 'iterate'
    };
  }

  // Allow custom image prompt override (from preview → edit → generate flow)
  if (customImagePrompt) {
    log.info(`🔄 [ITERATE] Page ${pageNumber}: Using custom image prompt (${customImagePrompt.length} chars, was ${imagePrompt.length})`);
    imagePrompt = customImagePrompt;
  }

  // Clear cache to force new generation
  const cacheKey = generateImageCacheKey(imagePrompt, referencePhotos.map(p => p.photoUrl), null);
  deleteFromImageCache(cacheKey);

  // Resolve previousImage based on blackout / useOriginalAsReference
  let previousImage = null;
  if (blackoutIssues) {
    const targets = optionFixTargets || [];
    if (targets.length > 0) {
      log.info(`🔄 [ITERATE] Page ${pageNumber}: Blacking out ${targets.length} issue regions in current image`);
      previousImage = await blackoutIssueRegions(imageData, targets);
    } else {
      log.warn(`🔄 [ITERATE] Page ${pageNumber}: No fix targets available for blackout, falling back to original as reference`);
      previousImage = imageData;
    }
  } else if (useOriginalAsReference) {
    previousImage = imageData;
    log.info(`🔄 [ITERATE] Page ${pageNumber}: Using original image as reference for generation`);
  }

  log.info(`🔄 [ITERATE] Page ${pageNumber}: Generating new image (referenceMode=${effectiveReferenceMode}, singlePassScene=${effectiveSinglePass})...`);

  // Apply reference-mode flag to refs/grid/landmarks/sceneBackground.
  const { applyReferenceMode } = getStoryHelpers();
  const refApplied = applyReferenceMode({
    mode: effectiveReferenceMode,
    characterPhotos: referencePhotos,
    visualBibleGrid,
    landmarkPhotos: finalLandmarkPhotos,
    sceneBackground,
    sceneMetadata: iterateSceneMetadata,
  });

  // Step 6: Generate image
  let imageResult;
  if (iterativePlacement) {
    const { resolveArtStyle: resolveIterStyle } = getStoryHelpers();
    const iterBackend = imageModelOverride ? (IMAGE_MODELS[imageModelOverride]?.backend || null) : null;
    const iterArtStyleDesc = resolveIterStyle(storyData.artStyle || 'pixar', iterBackend) || resolveIterStyle('pixar') || '';
    imageResult = await generateWithIterativePlacement(imagePrompt, refApplied.characterPhotos, iterateSceneMetadata, {
      imageModelOverride,
      imageBackendOverride: iterBackend,
      landmarkPhotos: refApplied.landmarkPhotos,
      visualBibleGrid: refApplied.visualBibleGrid,
      pageNumber,
      artStyle: iterArtStyleDesc,
      sceneBackground: refApplied.sceneBackground,
      landmarkScene: pageLandmarkScene(iteratePageRef),
    });
  } else {
    // Shared page generation — same entry Phase 5a uses. Eval + detection run
    // via the shared primitives below (skipped for pipeline callers, which
    // score round results themselves).
    const iterLabel = coverKey ? `${coverKey.toUpperCase()} ITERATE` : `PAGE ${pageNumber} ITERATE`;
    const genResult = await generateImageOnly(imagePrompt, refApplied.characterPhotos, {
      previousImage,
      imageModelOverride,
      landmarkPhotos: refApplied.landmarkPhotos,
      landmarkScene: pageLandmarkScene(iteratePageRef),
      visualBibleGrid: refApplied.visualBibleGrid,
      sceneBackground: refApplied.sceneBackground,
      pageNumber,
      artStyle,
      skipCache: true,
      aspectRatio: sceneAspect,
      captureLabel: coverOpts ? coverOpts.captureLabel : 'image_scene',
    });
    if (usageTracker && genResult?.usage) {
      const m = genResult.modelId || '';
      const genProvider = m.startsWith('runware:') ? 'runware' : m.startsWith('grok-imagine') ? 'grok' : 'gemini_image';
      usageTracker(genProvider, genResult.usage, coverOpts ? coverOpts.usageLabel : 'page_images', genResult.modelId);
    }
    let iterQuality = null;
    let iterDetection = null;
    if (!skipEval && genResult?.imageData) {
      try {
        // sceneCharacters is the photo-backed cast; story-invented characters
        // live only in the Visual Bible and must be appended, or the identity
        // call assigns a cast name to the invented figure
        // (job_1786737619634_d66c7bg9g p4).
        // Same identity line the first detection gets. A bare-name re-detect here
        // OVERWRITES a good detection: job_1786737619634_d66c7bg9g p4 ran a repair
        // and its stored expectedCharacters came back with empty descriptions.
        const iterClothing = iterateSceneMetadata?.characterClothing || {};
        const iterExpectedCharacters = (sceneCharacters || []).map(c => {
          const cname = c.name || c;
          if (typeof c !== 'object') return { name: cname, description: '' };
          let clothingText = '';
          if (iterClothing[cname]) {
            try {
              clothingText = require('./entityConsistency').buildClothingDescription(
                c, iterClothing[cname], artStyle, storyData?.clothingRequirements || null) || '';
            } catch { /* identity line goes without clothing */ }
          }
          // `clothing` AND `position` ride along as their own fields, exactly as
          // the generation-time builder supplies them (storyJobPipeline, phase
          // 5b-pre). Both were missing here, and both matter:
          //   clothing — the SoM prompt's sanitized tier STRIPS "Wearing:…" from
          //     the description and rebuilds the wardrobe from `c.clothing`, so
          //     without it every sanitized-tier identity line goes out undressed
          //     (bug som-identity-lines-undressed, fixed on the generation path
          //     2026-08-22 and never mirrored here).
          //   position — the SoM prompt's only non-appearance cue, and the
          //     layout fallback's xTarget/depth source. When the render has drawn
          //     a character with someone else's clothes and hair, appearance
          //     CANNOT separate the two and the declared placement is the only
          //     thing that can. Measured on job_1789681157795_wkt20ckod p12 v1
          //     (an iterate-round-1 detection, so this path): without the hint
          //     the identity call named the midground figure after the
          //     foreground one 3/3 runs; with it, 3/3 correct — same image, same
          //     badges, same model.
          return { name: cname, description: getStoryHelpers().buildIdentityLine(c, clothingText), clothing: clothingText,
            position: iterateSceneMetadata?.characterPositions?.[cname] || c.position || null };
        });
        iterExpectedCharacters.push(...getStoryHelpers().buildSecondaryExpectedCharacters(
          visualBible, iterateSceneMetadata, iterExpectedCharacters.map(c => c.name),
          { pageLabel: `${iterLabel} ` }
        ));
        // ONE ROSTER (2026-09-13) — same membership answer the iterate eval got.
        const { resolveExpectedCastNames: _resolveCast, reconcileDetectorCast: _reconcileCast } = require('./evalPipeline');
        const iterAuthoritative = _resolveCast({
          sceneCharacters: sceneCharacters || null,
          originalPrompt: newSceneDescription || '',
          visualBible,
          evaluationType: coverOpts ? 'cover' : 'scene',
          pageLabel: `${iterLabel} `,
          sceneMetadata: iterateSceneMetadata,
          pageNumber,
        });
        const iterReconciled = _reconcileCast(iterExpectedCharacters, iterAuthoritative,
          { visualBible, pageLabel: `${iterLabel} ` });
        iterDetection = await detectAllBoundingBoxes(genResult.imageData, {
          expectedCharacters: iterReconciled.entries,
          expectedObjects: Array.isArray(iterateSceneMetadata?.objects)
            ? iterateSceneMetadata.objects.filter(o => typeof o === 'string')
            : [],
          sceneContext: newSceneDescription,
          pageContext: iterLabel,
          artStyle,
        });
        if (iterDetection) iterDetection.expectedCastNames = iterReconciled.names;
      } catch (bboxErr) {
        log.warn(`⚠️ [ITERATE] Page ${pageNumber}: detection failed (${bboxErr.message})`);
      }
      try {
        iterQuality = await evaluateImageQuality(
          // genResult.prompt is the string generateImageOnly actually sent
          // (post-shrink); imagePrompt is the pre-shrink build.
          genResult.imageData, resolveEvalImagePrompt({ promptSent: genResult.prompt, originalPrompt: imagePrompt }),
          refApplied.characterPhotos, coverOpts ? 'cover' : 'scene', null,
          iterLabel, null, null, sceneCharacters, {
            // A cover's text contract (baked title / app-side typography),
            // resolved by the same resolver as its first render.
            ...(coverOpts ? { expectedText: coverOpts.expectedText, textMode: coverOpts.textMode } : {}),
            // Era-aware landmark protection — iterate uses the same refs it
            // just rendered from and the era it resolved above.
            landmarkPhotos: refApplied.landmarkPhotos || null,
            era: iterateSceneMetadata?.era || null,
            // The rewrite's PARSED metadata. Without it the iterate eval's
            // EXPECTED CAST roster silently loses every figure the brief filed
            // in objects[] — a VB secondary, an animal — and the page takes an
            // extra_character CRITICAL for drawing its own commissioned cast.
            sceneMetadata: iterateSceneMetadata || null,
            pageNumber,
            // DETECT-THEN-EVAL (2026-09-13). The detection above already runs
            // on these exact bytes; ordering it first costs no extra call and
            // gives the roster arithmetic its figure count.
            detectedFigures: iterDetection?.figures || null,
          }
        );
        if (usageTracker && iterQuality?.usage) {
          usageTracker('gemini_quality', iterQuality.usage, 'page_quality', iterQuality.modelId);
        }
      } catch (evalErr) {
        log.warn(`⚠️ [ITERATE] Page ${pageNumber}: eval failed (${evalErr.message}) — serving unscored render`);
      }
    }
    imageResult = {
      ...(iterQuality || {}),
      imageData: genResult.imageData,
      modelId: genResult.modelId,
      // The full string the provider received (generateImageOnly stamps the
      // post-shrink text on `prompt`). Carried out of here so the version this
      // rewrite becomes records ITS OWN prompt.
      promptSent: genResult.prompt || null,
      // The rewrite's prompt goes over the model cap as readily as the original
      // build did; `compressedScene` is what shrinkPromptForModel actually sent.
      // Dropped here, an iterate version had no sent prose of its own and the
      // judges fell back to a brief this image was never painted from.
      compressedScene: genResult.compressedScene || null,
      qualityModelId: iterQuality?.modelId || null,
      grokRefImages: genResult.grokRefImages || null,
      totalAttempts: 1,
      bboxDetection: iterDetection,
    };
    if (imageResult.score === undefined) imageResult.score = null;
    if (skipEval) imageResult.reasoning = 'no gen-time eval (pipeline scores versions)';
  }

  log.info(`🔄 [ITERATE] Page ${pageNumber}: New image generated (score: ${imageResult.score}, attempts: ${imageResult.totalAttempts})`);

  return {
    imageData: imageResult.imageData,
    imagePrompt,
    // THE STRING THE MODEL WAS HANDED, not the pre-shrink build. `imagePrompt`
    // above is what we ASSEMBLED; when that went over the model's cap,
    // shrinkPromptForModel rewrote or cut it and the provider saw something
    // else. The version record stamps this so a version's `prompt` and its
    // `compressedScene` (the head of this same string) describe ONE render —
    // the containment that made the cross-version prompt bug diagnosable.
    promptSent: imageResult.promptSent || imageResult.prompt || null,
    newScene: newSceneDescription,
    newSceneMetadata,
    // The rewritten scene is a NEW contract — its character set can legitimately
    // differ from the original plan (e.g. the rewrite re-includes a character
    // the outline dropped but the page text mentions). Callers must evaluate
    // the result against THIS contract, not the original page metadata.
    newSceneCharacters: sceneCharacters,
    previewMismatches,
    checksRun,
    compositionAnalysis: previewFeedback.composition,
    score: imageResult.score,
    reasoning: imageResult.reasoning,
    qualityModelId: imageResult.qualityModelId || null,
    fixTargets: imageResult.fixTargets || [],
    fixableIssues: imageResult.fixableIssues || [],
    // The post-shrink prose this rewrite was rendered from — null when its
    // prompt fit under the cap. The pipeline stamps it on the version entry.
    compressedScene: imageResult.compressedScene || null,
    totalAttempts: imageResult.totalAttempts,
    referencePhotos,
    landmarkPhotos: pageLandmarkPhotos,
    visualBibleGrid: visualBibleGrid ? `data:image/jpeg;base64,${visualBibleGrid.toString('base64')}` : null,
    grokRefImages: imageResult.grokRefImages || null,
    modelId: imageResult.modelId || null,
    bboxDetection: imageResult.bboxDetection || null,
    // The blackout image (when blackout mode was used and fixTargets were found)
    blackoutImage: (blackoutIssues && previousImage && previousImage !== imageData) ? previousImage : null,
    method: 'iterate'
  };
}

// Backward-compatible alias
const iteratePage = iteratePageCore;


/**
 * Repair character mismatch by replacing a specific character with their avatar
 *
 * @param {string} imageData - Current image data (base64)
 * @param {string} characterPhoto - Character's avatar photo (base64)
 * @param {Array<number>} bbox - Bounding box [ymin, xmin, ymax, xmax] in 0-1 normalized coords
 * @param {string} charName - Character name for the prompt
 * @param {Object} options - Options
 * @returns {Promise<Object>} { imageData, character, method: 'character_replacement' }
 */
async function repairCharacterMismatch(imageData, characterPhoto, bbox, charName, options = {}) {
  if (!bbox || bbox.length !== 4) {
    throw new Error('Valid bounding box required for character replacement');
  }

  // Route to Grok repair if requested
  if (options.imageBackend === 'grok') {
    return repairCharacterMismatchWithGrok(imageData, characterPhoto, bbox, charName, options);
  }

  // Default: Gemini repair — folded into the unified spine as model:'gemini'
  // (Stage 5). This was the last no-gate verbatim path: an ungated full-scene
  // Gemini repaint with no mask and no blend. It now flows through the SAME
  // treatment + samUnionBlend + gate battery (style-match / IoU / white-card /
  // coverage / sharpness) as grok and qwen. Axes come from the ONE central rule.
  const { repairCharacterFace, resolveRepairAxes } = require('./faceRepair');
  const geminiAxes = resolveRepairAxes(options.issueDescription, {
    hasFaceBbox: Array.isArray(options.faceBbox) && options.faceBbox.length === 4,
    forceTarget: (options.whiteoutTarget === 'face' || options.whiteoutTarget === 'body') ? options.whiteoutTarget : null,
    model: 'gemini',
  });
  return repairCharacterFace(imageData, characterPhoto, {
    ...options,
    ...geminiAxes,
    charName,
    bbox,
    bodyBbox: bbox,
    faceBbox: options.faceBbox,
  });
}

/**
 * Repair character mismatch using Grok Imagine edit endpoint.
 *
 * Two modes:
 * - Cut-out (options.useCutout = true): Extract bbox region, send region + characterRef to Grok,
 *   composite result back into original scene.
 * - Full scene (default): Send full scene + characterRef to Grok with repair prompt.
 *
 * @param {string} imageData - Current scene image (base64 data URI)
 * @param {string} characterPhoto - Character avatar photo (base64 data URI)
 * @param {Array<number>} bbox - Bounding box [ymin, xmin, ymax, xmax] in 0-1 normalized coords
 * @param {string} charName - Character name
 * @param {Object} options
 * @returns {Promise<Object>} { imageData, character, method, usage }
 */
// Grok image edits only support specific aspect ratios — pick the closest
// preset for a given source (width, height). Used by character repair so we
// don't send "1024:768" (which Grok may reject) and instead send "4:3".
// Full set of aspect presets the Grok Imagine edit endpoint supports lives
// in ./grokAspect (GROK_ASPECT_PRESETS + closestGrokAspect), imported above.
// The 13-preset set (incl 2:1, 1:2, 19.5:9, 9:19.5, 20:9, 9:20) gives tighter
// snaps for odd cutout shapes so the scene extract can naturally match a
// preset without any letterbox padding.
// Source: https://docs.x.ai/developers/model-capabilities/images/generation

/**
 * Pick an extract rectangle that naturally matches a Grok preset aspect.
 *
 * Given a character bbox in pixels and a desired padding factor, expand the
 * extract on ONE axis so the final crop dimensions land exactly on a supported
 * Grok aspect preset. No letterbox padding involved — we grab more scene pixels
 * instead. The extract is centered on the bbox and clamped to scene bounds.
 *
 * @param {object} args
 * @param {number} args.pixelLeft     - bbox left in scene pixels
 * @param {number} args.pixelTop      - bbox top in scene pixels
 * @param {number} args.pixelWidth    - bbox width in pixels
 * @param {number} args.pixelHeight   - bbox height in pixels
 * @param {number} args.padFactor     - minimum padding as fraction of bbox dim
 * @param {number} args.sceneWidth    - scene canvas width
 * @param {number} args.sceneHeight   - scene canvas height
 * @returns {{left:number, top:number, width:number, height:number, preset:string}}
 */

// Repaired-figure blur gate: reject when the repaired figure region has lost
// most of its edge detail vs the original. Ratio-based so soft art styles
// (watercolor) pass — both sides are equally soft there.
const REPAIR_SHARPNESS_REJECT_RATIO = 0.5;
const REPAIR_SHARPNESS_MIN_ORIG = 25; // orig region too flat → ratio meaningless, skip gate

// Production FACE repair via the shared SAM-union insert blend (samBlend.samUnionBlend)
// — the Test-Lab "insert path" ported to prod: square face crop → SAM head whiteout →
// Grok redraw → SAM round-1∪round-2 union → erode-then-feather composite. NO crosshatch,
// NO rectangular blend. Feather-only first (colorCorrect:false; garment/border colour is
// a later follow-up). The blended FACE branch calls this inside a try/catch → falls back
// to the legacy blur+rectangular blend on ANY failure (SAM down, gate reject, style
// drift), so a repair always returns an image. Everything stays in CROP space; the
// feathered crop is composited back at the crop origin. Mirrors runQwenInsertStage.
async function repairCharacterMismatchWithGrok(imageData, characterPhoto, bbox, charName, options = {}) {
  // ── ADAPTER (Stage 3) ─────────────────────────────────────────────────────
  // The five legacy Grok repair branches (blended / cutout / fullScene inpaint /
  // blackout + the face-insert early-return) and their two private blend engines
  // were deleted here and MERGED into the unified 3-axis spine repairCharacterFace
  // (server/lib/faceRepair.js). This thin adapter keeps the old signature and
  // legacy option flags working: it validates + expands the bbox exactly as
  // before, maps the flags onto {regionSource, treatment, model, faceOnly} via
  // legacyFlagsToAxes, and hands off. All region/treatment/model/blend logic and
  // EVERY gate (style-match, IoU, white-card, coverage, requireMobilesam,
  // sharpness) now live in the spine — one path, no branch skips a gate.
  // See docs/face-repair-merge-design.md.
  if (!isGrokConfigured()) {
    throw new Error('XAI_API_KEY not configured for Grok repair');
  }

  // Runtime metrics: every char-repair invocation. The styled-avatar cache
  // scope IS the jobId (== storyId) inside a full-mode pipeline run; undefined
  // outside one (manual repair endpoints) → forJob() no-ops.
  require('./runMetrics').forJob(require('./styledAvatars')._cacheContext?.getStore?.()).count('char_repair_run');

  let [ymin, xmin, ymax, xmax] = bbox;

  // Validate bbox coordinates — NaN or out-of-range values crash Sharp.
  if ([ymin, xmin, ymax, xmax].some(v => v == null || isNaN(v) || v < 0 || v > 1) || ymin >= ymax || xmin >= xmax) {
    log.warn('⚠️ [CHAR REPAIR GROK] Invalid bbox for ' + charName + ': [' + bbox.join(', ') + '] — skipping');
    return { imageData: null, character: charName, method: 'grok_blended', error: 'Invalid bounding box' };
  }

  // Face bbox union expansion: if a separate face box pokes outside the body box
  // (detector cut through the character), expand the body box to contain it so
  // the treatment mask doesn't miss half the face.
  // FAITHFULNESS-CHECK: images.js:11318-11341 (pre-merge).
  const faceBboxIn = options.faceBbox;
  if (Array.isArray(faceBboxIn) && faceBboxIn.length === 4
      && faceBboxIn.every(v => v != null && !isNaN(v) && v >= 0 && v <= 1)) {
    const [fymin, fxmin, fymax, fxmax] = faceBboxIn;
    if (fymin < ymin || fxmin < xmin || fymax > ymax || fxmax > xmax) {
      ymin = Math.min(ymin, fymin); xmin = Math.min(xmin, fxmin);
      ymax = Math.max(ymax, fymax); xmax = Math.max(xmax, fxmax);
      bbox = [ymin, xmin, ymax, xmax];
      log.info('👤 [CHAR REPAIR GROK] Face bbox outside body bbox — expanded body bbox to union [' + bbox.map(v => Math.round(v * 100) + '%').join(', ') + ']');
    }
  }

  // Legacy flags → 3 axes (the face-insert precedence, the blended/cutout/
  // fullScene modes, and the deprecated blackout default all live in
  // legacyFlagsToAxes).
  const { repairCharacterFace, legacyFlagsToAxes } = require('./faceRepair');
  const axes = legacyFlagsToAxes({
    useBlended: options.useBlended === true ? true : null,
    useCutout: options.useCutout === true ? true : null,
    useFullScene: options.useFullScene === true ? true : null,
    whiteoutTarget: options.whiteoutTarget || 'body',
    hasFaceBbox: Array.isArray(options.faceBbox) && options.faceBbox.length === 4,
    model: 'grok',
  });

  // An EXPLICIT axis beats the legacy mapping. `...axes` is spread after
  // `...options` to stop a stray same-named key leaking in, but that also threw
  // away a deliberate override: a Test Lab arm asking for treatment 'blur' on a
  // face got the mapping's answer instead, so a blur-vs-whiteout A/B silently
  // ran the same treatment twice (exps 862/863). Only keys the caller actually
  // set are re-applied, so production — which sets none — is unchanged.
  // NULL IS "NOT SET" (2026-09-06). buildCharRepairRequest materialises EVERY
  // canonical key, filling absent ones with null — so `faceOnly: null` is present
  // on every request the button, the pipeline and the Lab build. `!== undefined`
  // accepted that null as a deliberate override and forced `faceOnly = false`,
  // silently downgrading EVERY face repair to a full-figure one: the resolved
  // axes `grok:cutout:blur:face` became `grok:box:blur:body` (the body box then
  // trips the degenerate-cutout→box guard). Reproduced in Lab exp #996 —
  // whiteoutTarget 'face' came back with descriptor grok:box:blur:body. treatment
  // and regionSource were unaffected only because their checks are truthiness
  // tests and null is falsy; faceOnly is the one boolean axis, so it is the one
  // that broke. Face repair has therefore been unreachable through the shared
  // contract since it landed.
  const explicitAxes = {};
  if (options.treatment) explicitAxes.treatment = options.treatment;
  if (options.regionSource) explicitAxes.regionSource = options.regionSource;
  if (options.faceOnly !== undefined && options.faceOnly !== null) explicitAxes.faceOnly = !!options.faceOnly;

  return repairCharacterFace(imageData, characterPhoto, {
    ...options,      // issueDescription, clothingDescription, sceneDescription,
                     // photoType, protectedFaces/Bodies, textPosition, artStyle,
                     // includeDebug, characterDescription/richDescription, etc.
    ...axes,         // regionSource / treatment / model / faceOnly (override any
                     // stray same-named option keys).
    ...explicitAxes, // ...unless the caller named one deliberately.
    charName,
    bbox,
    bodyBbox: bbox,
    faceBbox: options.faceBbox,
  });
}


/**
 * Edit an image based on a user-provided prompt using Gemini's image editing capabilities
 * Pure text/instruction based - no character photos to avoid regeneration artifacts
 * @param {string} imageData - The original image data (base64)
 * @param {string} editInstruction - What the user wants to change
 * @returns {Promise<{imageData: string}|null>}
 */
async function editImageWithPrompt(imageData, editInstruction, model, referenceImages = [], artStyle = null, aspectRatioOverride = null) {
  editInstruction = guardPromptString(editInstruction, 'images.editImageWithPrompt');
  const modelId = model || MODEL_DEFAULTS.pageImage;
  const modelConfig = IMAGE_MODELS[modelId];
  const backend = modelConfig?.backend || 'gemini';
  // editWithGrok center-crops every input to match the requested aspect ratio.
  // For an EDIT of an existing image the right output aspect is the source's
  // own aspect — Grok's /edits endpoint returns at input aspect anyway. If we
  // pass a different ratio (e.g. coverAspect='3:4'=0.75 vs the actual 880×1245
  // cover at 0.707), the crop slices ~36px off the top and bottom of the cover
  // before Grok ever sees it, cutting into the burned-in title text.
  // Measure imageData and use its actual aspect; fall back to caller override
  // or the global default when measurement fails.
  let measuredAspect = null;
  try {
    if (typeof imageData === 'string') {
      const m = imageData.match(/^data:image\/\w+;base64,(.+)$/);
      const buf = m ? Buffer.from(m[1], 'base64') : null;
      if (buf) {
        const meta = await sharp(buf).metadata();
        if (meta.width && meta.height) {
          // Snap to the nearest preset both Grok and Gemini accept. Raw
          // "1024:1024" is rejected by both APIs ("unknown variant"); even
          // GCD-reduced values like "176:249" (an 880×1245 cover) aren't on
          // either side's allow-list. Pick the closest standard preset by
          // ratio. Order matters only for ties — list runs portrait → square
          // → landscape so the natural reading is preserved.
          const PRESETS = [
            ['9:16', 9 / 16],   // 0.5625
            ['2:3',  2 / 3],    // 0.667
            ['3:4',  3 / 4],    // 0.75
            ['4:5',  4 / 5],    // 0.8
            ['1:1',  1],        // 1.0
            ['5:4',  5 / 4],    // 1.25
            ['4:3',  4 / 3],    // 1.333
            ['3:2',  3 / 2],    // 1.5
            ['16:9', 16 / 9],   // 1.778
          ];
          const r = meta.width / meta.height;
          let best = PRESETS[0];
          let bestDelta = Math.abs(Math.log(r / best[1]));
          for (const p of PRESETS) {
            const delta = Math.abs(Math.log(r / p[1]));
            if (delta < bestDelta) { best = p; bestDelta = delta; }
          }
          measuredAspect = best[0];
        }
      }
    }
  } catch { /* fall through */ }
  const aspectRatio = measuredAspect || aspectRatioOverride || CONFIG_DEFAULTS.pageAspect;

  log.debug(`✏️  [IMAGE EDIT] Editing image with instruction: "${editInstruction}" (model: ${modelId}, backend: ${backend}, refs: ${referenceImages.length}, aspect: ${aspectRatio})`);

  // Resolve the art-style description so the edit prompt can anchor it.
  // Without this, Grok's edit endpoint defaults to its house cartoon/anime
  // style when repainting faces, even when the source image is realistic.
  const { resolveArtStyle } = getStoryHelpers();
  const styleText = (artStyle && resolveArtStyle)
    ? (resolveArtStyle(artStyle, backend) || '')
    : '';

  // Build the editing prompt from template
  const editPrompt = fillTemplate(PROMPT_TEMPLATES.illustrationEdit, {
    EDIT_INSTRUCTION: editInstruction,
    ART_STYLE: styleText || 'Match the source image\'s artistic style.',
  });
  log.debug(`✏️  [IMAGE EDIT] Full prompt: "${editPrompt}"`);

  if (backend === 'grok') {
    // Grok edit path — uses /images/edits endpoint with reference images
    // Include the current image + any additional character/VB references
    const allRefs = [imageData, ...referenceImages].slice(0, 3); // Grok max 3 refs
    try {
      const grokResult = await editWithGrok(editPrompt, allRefs, { model: modelConfig.modelId, aspectRatio });
      log.info(`✅ [IMAGE EDIT] Successfully edited image via Grok`);
      return {
        imageData: grokResult.imageData,
        // direct_cost carried through: addUsage (storyJobPipeline) only sums
        // usage.direct_cost — dropping it here made every Grok edit routed via
        // this dispatcher (style_repair etc.) record $0.
        usage: { model: modelId, cost: grokResult.usage?.cost, direct_cost: grokResult.usage?.direct_cost ?? grokResult.usage?.cost }
      };
    } catch (grokErr) {
      // Content moderation block — sanitize prompt and retry, then fall back to Gemini
      if (grokErr.message?.includes('content moderation') || grokErr.message?.includes('400')) {
        log.warn(`⚠️ [IMAGE EDIT] Grok blocked by content moderation, sanitizing prompt and retrying...`);
        // Soften violent/weapon language for retry.
        //
        // ORDER MATTERS, and the chin rule has to come FIRST. It is written for
        // an instruction that already says "touch … chin" in the author's own
        // words; the violence rule below injects the word "touch" throughout the
        // prompt, so running the chin rule after it let an INJECTED "touch"
        // anchor the match. Worse, the rule used to read `/touch.*chin/gi`: the
        // `.*` is greedy and `chin` was unanchored, so it matched inside
        // ordinary words — "crouching", "reaching", "catching", "chin-length",
        // "etching" — and swallowed every character between the first injected
        // "touch" and the last such word on the line. Measured 2026-09-18 across
        // the 529 stored inpaint instructions that reach this function (219
        // production, 310 staging): 19 production and 36 staging carry a `chin`
        // substring and EVERY one of them is inside a word like "crouching" or
        // "chin-length". None has yet shared a line with a violence word, so
        // nothing has shipped mangled — but the collision is one edit
        // instruction away, not a hypothesis. Bounded window, word-anchored
        // `chin`, and no match on a hyphenated "chin-length" haircut.
        const sanitized = editPrompt
          .replace(/\btouch\w*[^.\n]{0,40}?\bchin(?![\w-])/gi, 'be positioned near the face')
          .replace(/\b(stab|pierce|impale|kill|slay|attack|strike|hit|slash|cut|wound|bleed|blood|die|dead|death)\b/gi, 'touch')
          .replace(/\b(spear|sword|knife|blade|weapon|arrow|axe)\s+(go(?:es|ing)?|plung(?:es|ing)?|driv(?:es|ing)?|thrust(?:s|ing)?)\s+(into|through)\b/gi, '$1 reaches toward')
          .replace(/\b(into|through)\s+(the\s+)?(body|chest|stomach|head|neck|heart|flesh|skin)\b/gi, 'near the $3')
          .replace(/going into/gi, 'pointing at');
        if (sanitized !== editPrompt) {
          log.info(`🔄 [IMAGE EDIT] Retrying with sanitized prompt: "${sanitized.substring(0, 120)}..."`);
          try {
            const retryResult = await editWithGrok(sanitized, [imageData], { model: modelConfig.modelId, aspectRatio });
            log.info(`✅ [IMAGE EDIT] Sanitized retry succeeded via Grok`);
            return {
              imageData: retryResult.imageData,
              usage: { model: modelId, cost: retryResult.usage?.cost, direct_cost: retryResult.usage?.direct_cost ?? retryResult.usage?.cost }
            };
          } catch (retryErr) {
            log.warn(`⚠️ [IMAGE EDIT] Sanitized retry also blocked, falling back to Gemini`);
          }
        }
        // Fall through to Gemini path below
        log.info(`🔄 [IMAGE EDIT] Falling back to Gemini for content-moderated edit`);
      } else {
        log.error(`❌ [IMAGE EDIT] Grok edit failed, falling back to Gemini: ${grokErr.message}`);
        // Fall through to Gemini path below
      }
    }
  }

  // Gemini edit path — uses generateContent with responseModalities: IMAGE
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key not configured');
    }

    // Extract base64 and mime type from the image
    const base64Data = r2Lib.stripDataUriPrefix(imageData);
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Build parts array with text FIRST, then image (helps model understand it's an edit instruction)
    const parts = [
      { text: editPrompt },
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      }
    ];

    // When this branch is reached via Grok fallback, modelConfig.modelId is a
    // Grok model id ('grok-imagine-image'), which Gemini's API doesn't know
    // and returns 404 for. Only trust modelConfig.modelId when the backend is
    // actually Gemini — otherwise use the canonical Gemini image model id.
    const geminiModelId = modelConfig?.backend === 'gemini'
      ? modelConfig.modelId
      : 'gemini-2.5-flash-image';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModelId}:generateContent?key=${apiKey}`;

    const systemInstruction = getImageSystemInstruction();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        ...(systemInstruction && { systemInstruction }),
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          temperature: 0.6,
          ...(modelSupportsThinking(geminiModelId) && { thinkingConfig: { includeThoughts: true } }),
          imageConfig: {
            aspectRatio
          }
        }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      log.error('❌ [IMAGE EDIT] Gemini API error:', error);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();

    // Extract token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    const thinkingTokens = data.usageMetadata?.thoughtsTokenCount || 0;
    log.debug(`📊 [IMAGE EDIT] Token usage - input: ${inputTokens}, output: ${outputTokens}${thinkingTokens ? `, thinking: ${thinkingTokens}` : ''}, model: ${modelId}`);

    // Extract thinking text
    const thinkingText = extractThinkingFromParts(data.candidates?.[0]?.content?.parts, 'IMAGE EDIT');

    // Extract the edited image from the response
    if (data.candidates && data.candidates[0]?.content?.parts) {
      const responseParts = data.candidates[0].content.parts;
      log.debug(`✏️  [IMAGE EDIT] Found ${responseParts.length} parts in response`);

      for (const part of responseParts) {
        // Check both camelCase (inlineData) and snake_case (inline_data) - Gemini API varies
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData && inlineData.data) {
          const respMimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
          const editedImageData = `data:${respMimeType};base64,${inlineData.data}`;
          log.info(`✅ [IMAGE EDIT] Successfully edited image`);
          return { imageData: editedImageData, thinkingText, usage: { inputTokens, outputTokens, thinkingTokens, model: modelId } };
        }
      }
    }

    log.warn('⚠️  [IMAGE EDIT] No edited image in response');
    return { imageData: null, usage: { inputTokens, outputTokens, model: modelId } };
  } catch (error) {
    log.error('❌ [IMAGE EDIT] Error editing image:', error);
    throw error;
  }
}

/**
 * Composite routing for the shared image path.
 *
 * `composite` is a first-class route helper on the shared image path, not a
 * cover-only fork. When `options.composite === true` AND the landmark-buffer
 * prerequisite is met, the image is produced by the manual-composite + 2-pass
 * Grok pipeline (`generateCoverViaComposite`) instead of the normal direct
 * generate+eval path, and returned in an imageResult-shaped object marked
 * `composite:true`. The composite result skips quality eval (score null) —
 * identical to the behaviour before this became a shared-path option.
 *
 * Returns null to signal "run the normal direct generate+eval path". That
 * happens in three cases, each byte-identical to the previous cover fork:
 *   1. composite not requested (the DEFAULT — every page image; pages never set
 *      the option, so they skip this entirely and are unaffected),
 *   2. composite requested but the landmark-buffer prerequisite is missing
 *      (invented-location fallback → direct render with location prose),
 *   3. the composite generator threw (fall back to direct).
 *
 * Gated on the OPTION VALUE, never on evaluationType — a page COULD opt in
 * (owner principle: covers and images share one code path, composite is just an
 * option that is ON for covers and OFF for pages). Defaults differ, code does not.
 *
 * @param {Object} options - { composite: true, compositeInputs } bag
 * @param {Function|null} usageTracker - forwarded to the composite generator
 * @param {string} pageLabel - log prefix
 * @returns {Promise<Object|null>} composite imageResult, or null → run direct path
 */
async function _maybeGenerateComposite(options, usageTracker = null, pageLabel = '') {
  if (!options || options.composite !== true) return null;
  const ci = options.compositeInputs || {};
  // Composite requires a real background plate (the landmark buffer). Without
  // one, pass 2 (the photo-protection edit) is skipped and the path degrades to
  // figures-on-white — so covers for invented/landmark-less locations fall back
  // to the direct render, whose location prose drives the backdrop directly.
  if (!ci.landmarkBuf) {
    log.info(`🎨 [QUALITY RETRY] ${pageLabel}composite requested but no landmark buffer — using normal generation`);
    return null;
  }
  try {
    const { generateCoverViaComposite } = require('./coverComposite');
    const compositeResult = await generateCoverViaComposite({
      coverKey: ci.coverKey,
      characters: ci.characters,
      coverHint: ci.coverHint,
      sceneDescription: ci.sceneDescription,
      vbGrid: ci.vbGrid,
      landmarkBuf: ci.landmarkBuf,
      sceneBackground: ci.sceneBackground,
      artStyle: ci.artStyle,
      title: ci.title,
      dedication: ci.dedication,
      styleHint: ci.styleHint,
      usageTracker,
      visualBible: ci.visualBible,
      orient: ci.orient || 'frontal',
    });
    log.info(`🎨 [QUALITY RETRY] ${pageLabel}composite-cover generated (modelId=${compositeResult.modelId})`);
    return {
      composite: true,
      imageData: compositeResult.imageData,
      score: null, // composite path skips quality eval — returns immediately
      reasoning: 'composite-cover (no quality eval)',
      modelId: compositeResult.modelId,
      totalAttempts: compositeResult.totalAttempts || 1,
      prompt: compositeResult.prompt,
      usage: { cost: 0.04, direct_cost: 0.04 }, // 2 Grok edits
      grokRefImages: null,
      compositeDebug: compositeResult.debug,
    };
  } catch (err) {
    log.warn(`⚠️ [QUALITY RETRY] ${pageLabel}composite path failed: ${err.message} — falling back to normal path`);
    return null;
  }
}

/**
 * Delete a specific entry from the image cache
 * @param {string} cacheKey - The cache key to delete
 * @returns {boolean} True if the key was deleted, false if it didn't exist
 */
function deleteFromImageCache(cacheKey) {
  if (imageCache.has(cacheKey)) {
    imageCache.delete(cacheKey);
    return true;
  }
  return false;
}


/**
 * Get cache statistics for logging
 * @returns {{image: Object, ref: Object}} Stats for both caches
 */
function getCacheStats() {
  return {
    image: imageCache.getStats(),
    ref: compressedRefCache.getStats()
  };
}



// ============================================
// AUTO-REPAIR (INPAINTING) FUNCTIONS
// ============================================

/**
 * Inspect an image for physics/visual errors using Gemini Flash
 * @param {string} imageData - Base64 image data URL
 * @returns {Promise<{errorFound: boolean, errorType?: string, description?: string, boundingBox?: number[], fixPrompt?: string}>}
 */


// =============================================================================
// REFERENCE SHEET GENERATION FOR SECONDARY ELEMENTS
// =============================================================================

/**
 * Split a grid image into individual reference images.
 *
 * Tries the Python /split-reference-sheet endpoint first — it uses variance
 * analysis to find the actual cell boundaries (handles visible gaps, title
 * bars, uneven cell sizes). Falls back to blind sharp-based math if the
 * Python service is unavailable.
 *
 * @param {Buffer|string} gridImage - Grid image as Buffer or base64 data URL
 * @param {number} count - Number of elements in the grid
 * @returns {Promise<string[]>} Array of base64 PNG images (without data URL prefix)
 */

/**
 * Collect ALL fixable issues for a given page from every source:
 * quality eval, retry history, entity consistency (characters + objects), and image checks.
 * Returns a unified array of issue objects suitable for enrichWithBoundingBoxes.
 */
function collectAllIssuesForPage(scene, storyData, pageNumber) {
  const issues = [];

  // Source 1: Quality eval fixableIssues (on scene)
  if (scene.fixableIssues?.length) {
    issues.push(...scene.fixableIssues.map(i => ({ ...i, source: 'quality eval' })));
  }

  // Source 2: Retry history evals
  const latestRetry = scene.retryHistory?.slice(-1)[0];
  if (latestRetry?.postRepairEval?.fixableIssues?.length) {
    issues.push(...latestRetry.postRepairEval.fixableIssues.map(i => ({ ...i, source: 'post-repair eval' })));
  }
  if (latestRetry?.preRepairEval?.fixableIssues?.length) {
    issues.push(...latestRetry.preRepairEval.fixableIssues.map(i => ({ ...i, source: 'pre-repair eval' })));
  }

  // Sources 3+4: Entity consistency issues (characters + objects), read by
  // scoring.entityFindingsForPage — the same reader the score bills from, so
  // this list holds exactly the entity findings the page's score counted.
  const { entityFindingsForPage } = require('./scoring');
  for (const { name, issue, offByDesign } of entityFindingsForPage(pageNumber, storyData.finalChecksReport?.entity)) {
    if (offByDesign) continue; // the page takes this garment off — not a defect here, never a repair input
    issues.push({
      description: issue.fixInstruction || issue.description,
      severity: issue.severity,
      // Real entity class first (face_drift, hair_nuance, ...) — the
      // report keeps it in subType with type flattened to 'consistency'.
      type: issue.subType || issue.type || 'consistency',
      fix: issue.canonicalVersion || issue.fixInstruction || '',
      character: name,
      source: 'entity check',
    });
  }

  // Source 5: Image checks (cross-page consistency)
  if (storyData.finalChecksReport?.imageChecks) {
    for (const check of storyData.finalChecksReport.imageChecks) {
      for (const issue of check.issues || []) {
        if (issue.pagesToFix?.includes(pageNumber) || issue.images?.includes(pageNumber)) {
          issues.push({
            description: issue.description,
            severity: issue.severity,
            type: issue.type || 'consistency',
            fix: issue.recommendation || issue.description,
            character: issue.characterInvolved || check.characterName || null,
            source: 'image checks',
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Apply style transfer: re-render an existing image in the story's art style using a different model.
 * Sends the current image as a reference and asks the model to redraw it in the specified art style,
 * keeping all characters, positions, and scene composition identical.
 */
async function applyStyleTransfer(imageData, artStyle, options = {}) {
  const { imageModelOverride, imageBackendOverride } = options;
  const { resolveArtStyle } = require('./storyHelpers');

  // artStyle can be: a preset key ("pixar"), or a custom description string
  const styleDescription = resolveArtStyle(artStyle, imageBackendOverride) || artStyle;

  // Style transfer: input image is the ONLY reference. No avatars — they cause
  // the model to redraw faces from the avatar (which often look photo-real),
  // defeating the whole point of restyling.
  //
  // Prompt design notes:
  //   - "Layout reference" framing tells the model the input is COMPOSITION
  //     ONLY, not rendering. Without this, Grok/Gemini treat the previous
  //     image as authoritative and barely restyle (or restyle backgrounds
  //     while leaving faces photo-real, which is the #1 user complaint).
  //   - Style is at the TOP, before composition rules — earlier tokens get
  //     more weight.
  //   - Explicit per-element enforcement (faces, skin, hair, clothing, sky,
  //     ground) closes the loophole where the model styles backgrounds but
  //     leaves figures in source rendering.
  //   - Anti-photo banner addresses the recurring "figures look like photos"
  //     case directly.
  const prompt = fillTemplate(LOCAL_PROMPTS.styleTransfer, {
    STYLE_DESCRIPTION: styleDescription,
  });

  log.info(`🎨 [STYLE TRANSFER] target: ${artStyle}, model: ${imageModelOverride || 'default'} (no avatars — input image is sole reference)`);

  // characterPhotos intentionally omitted — see comment above. The previousImage
  // is the only reference attached, so the model can't drift toward an avatar.
  return generateImageOnly(prompt, [], {
    imageModelOverride,
    imageBackendOverride,
    previousImage: imageData,
    skipCache: true,
  });
}

module.exports = {
  // Everything the two domain modules export, forwarded by construction. The
  // explicit list below keeps the documented surface and wins for any name this
  // file defines locally — so every locally defined name belongs BELOW the
  // spreads, never above them.
  ...evalPipelineModule,
  ...bboxDetectionModule,
  carryEvalEvidence,
  renderStoryPagePlate,
  ensureStoryPagePlate,
  resolveIteratePlate,

  // Gemini plumbing consumed by imageInpainting via lazy accessors (the
  // inpaint LLM-verify path); exported for that one consumer.
  withRetry,
  modelSupportsThinking,
  getImageSystemInstruction,
  extractThinkingFromParts,
  // Utility functions
  hashImageData,
  generateImageCacheKey,
  cropImageForSequential,
  compressImageToJPEG,
  // Live shared ref-compression LRU — single instance; evalPipeline.js reaches
  // it lazily via require('./images').compressedRefCache. Never duplicate it.
  compressedRefCache,
  buildExpectedCharactersForBbox,
  buildObjectGroundingHints,
  // Exported for tests/unit/sam-mask-guard.test.ts — the SAM acceptance rule
  // decides every figure's bodyBox, so its thresholds need direct coverage.

  // Core image functions
  validateEmptyScene,
  evaluateImageQuality,
  evaluateThreeStage,
  capComplianceIdentitySeverity,
  callGeminiAPIForImage,
  editImageWithPrompt,
  _maybeGenerateComposite,
  rewriteBlockedScene,

  // Separated evaluation pipeline functions (new architecture)
  generateImageOnly,
  generateWithIterativePlacement,
  applyStyleTransfer,
  evaluateImageBatch,
  composeEvalReferencePhotos,

  // Unified repair pipeline (the only active repair pipeline)
  inpaintPage,

  // Active repair primitives
  iteratePageCore,
  iteratePage,
  repairCharacterMismatch,

  // Cache management
  deleteFromImageCache,
  getCacheStats,

  // Mask + region helpers (used by inpaint paths)

  // Two-stage bounding box detection — implementation lives in ./bboxDetection
  // (verbatim move, 2026-08-11); re-exported here so consumers keep importing
  // from './images'. Same function objects — never a duplicate implementation.
  detectAllBoundingBoxes,
  imageFingerprint,
  bboxPairsWith,
  restampDetectionForCoverText,
  detectionForVersion,
  parseVisualBibleObjects,
  resolveExpectedObjectLabels,
  escapeXml,
  _hashBboxKey,
  _bboxCacheGet,
  _bboxCacheSet,
  // Region/geometry + treatment helpers consumed by the unified faceRepair.js.
  // Exported (minimal) rather than duplicated so the merge stays single-source.
  REPAIR_SHARPNESS_MIN_ORIG,
  REPAIR_SHARPNESS_REJECT_RATIO,
  closestGrokAspect,
  detectSubRegion,  // Sub-region detection for targeted repairs (shoes, shirt, hands, etc.)
  createBboxOverlayImage,  // Create overlay image with boxes drawn
  createSamInputOverlayImage,  // Per-figure SAM prompt: box + labelled points
  createCutoutSheetImage,      // The final cut-outs, full height, as their own image
  getBboxCacheStats, // Telemetry for the content-hashed bbox cache
  FIGURE_COLORS,  // Color palette for bbox overlay (shared with prompt building)
  isMicroFigure,
  countRealFigures,
  vbNonHumanNames,
  callGrokVisionAPI,  // Grok vision API for bbox/quality eval
  callOpenRouterVisionAPI,  // OpenRouter vision judges for the blind inventory (Lab)
  GEMINI_SAFETY_SETTINGS,  // Safety settings for Gemini API calls
  enrichWithBoundingBoxes,

  // Reference sheet generation for secondary elements

  // Issue collection
  collectAllIssuesForPage,

  // Standalone visual inventory (for evaluate-single endpoint)
  runVisualInventory,

  // Sanitization helpers
  sanitizeForGemini,

  // Constants (for external access if needed)
  IMAGE_QUALITY_THRESHOLD,

  // Remaining evalPipeline exports, forwarded so the facade is complete
  // (tests/unit/images-facade-complete.test.ts pins this).
  presenceCounterName,
  largestInteriorUniformFraction,
  buildEvalClothingContract,
  buildEvalRequiredObjects,
  buildExpectedCastBlock,
  resolveExpectedCastNames,
  reconcileDetectorCast,
  parseFixableIssues,
  derivePresenceFinding,
  supersedePresenceFindings,
  PRESENCE_DERIVED_MARKER,
  PRESENCE_COUNT_TYPES,

  // Pure dispatch helpers (exported for unit tests / reuse)
  resolveOutputAspect,
  truncatePromptForModel,
  shrinkPromptForModel,
  PROMPT_CUT_ORDER,
  PROMPT_NEVER_CUT,
  extractDataImageUrls
};
