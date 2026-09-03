/**
 * "Inpainting" — MOSTLY DEAD. Read this before trusting the name.
 *
 * ⚠ THE LIVE REPAIR METHOD CALLED `inpaint` DOES NOT INPAINT. `inpaintPage()`
 * (in images.js) builds a text instruction from the quality + semantic findings
 * and hands the WHOLE IMAGE to `editImageWithPrompt()` → Grok/Gemini, which
 * returns a WHOLE NEW IMAGE. There is no mask and nothing is preserved:
 * composition, other characters, background and style can all drift, and
 * measured they do — 2 of 8 attempts improved the page, average −11.1 points.
 *
 * True masked inpainting — where everything outside the mask survives
 * byte-for-byte — lives in THIS file and is NOT WIRED IN. The mask dispatcher
 * and the Runware pixel backend were built (2026-03-25 plan) and never given a
 * live caller; they are marked as dead code and kept per owner decision.
 *
 * So: "inpaint" in repairLogic, evalBuckets and the dev panel means
 * "whole-image text edit", not "local repair". Anything reasoning about blast
 * radius — "only the mask changed, so we can skip a re-eval" — is WRONG for the
 * live path. Every repaired version needs a full re-evaluation.
 *
 * Split out of images.js 2026-08-09. Self-contained apart from image
 * compression: mask construction, target grouping, before/after verification
 * (LPIPS and LLM), and the Runware and Grok backends.
 *
 * `dimensionCache` moved with this cluster — nothing outside it reads image
 * dimensions.
 *
 * compressImageToJPEG is required LAZILY inside the two functions that need it.
 * images.js imports blackoutIssueRegions from here, so a top-level require of
 * images.js would close a cycle.
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');
const { MODEL_DEFAULTS } = require('../config/models');
const { closestGrokAspect } = require('./grokAspect');
const { editWithGrok, GROK_MODELS } = require('./grok');
const { isRunwareConfigured } = require('./runware');
const r2Lib = require('./r2');
const { PROMPT_TEMPLATES, fillTemplate, applyRepairStyleGuard } = require('../services/prompts');

// The one local prompt this cluster uses. Read here rather than importing
// images.js's LOCAL_PROMPTS map, which would close a require cycle.
const LOCAL_PROMPTS = {
  inpaintGrokRegions: applyRepairStyleGuard(
    fs.readFileSync(path.join(__dirname, '../../prompts', 'inpaint-grok-regions.txt'), 'utf-8')
  ),
};

const getStoryHelpers = () => require('./storyHelpers');
const compressImageToJPEG = (...args) => require('./images').compressImageToJPEG(...args);
const withRetry = (...args) => require('./images').withRetry(...args);
const modelSupportsThinking = (...args) => require('./images').modelSupportsThinking(...args);
const getImageSystemInstruction = (...args) => require('./images').getImageSystemInstruction(...args);
const extractThinkingFromParts = (...args) => require('./images').extractThinkingFromParts(...args);

async function inspectImageForErrors(imageData) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key not configured');
    }

    log.debug('🔍 [INSPECT] Analyzing image for physics errors...');

    // Extract base64 and mime type
    const base64Data = r2Lib.stripDataUriPrefix(imageData);
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Load the inspection prompt
    const inspectionPrompt = PROMPT_TEMPLATES.imageInspection ||
      'Analyze this image for physics errors. Return JSON with error_found (boolean), error_type, description, bounding_box [ymin,xmin,ymax,xmax], and fix_prompt.';

    // Build parts array
    const parts = [
      { text: inspectionPrompt },
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      }
    ];

    // Use utility model for fast analysis
    const modelId = MODEL_DEFAULTS.utility;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1024
        }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      log.error('❌ [INSPECT] Gemini API error:', error);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();

    // Extract and log token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    log.debug(`📊 [INSPECT] Token usage - input: ${inputTokens}, output: ${outputTokens}, model: ${modelId}`);

    // Extract text response
    if (data.candidates && data.candidates[0]?.content?.parts) {
      const textPart = data.candidates[0].content.parts.find(p => p.text);
      if (textPart) {
        const responseText = textPart.text.trim();
        log.debug('🔍 [INSPECT] Raw response:', responseText.substring(0, 300));

        // Parse JSON from response (handle markdown code blocks)
        let jsonStr = responseText;
        const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          jsonStr = jsonMatch[1].trim();
        }

        try {
          const result = JSON.parse(jsonStr);

          if (result.error_found) {
            log.info(`🔍 [INSPECT] Error detected: ${result.error_type} - ${result.description}`);
            return {
              errorFound: true,
              errorType: result.error_type,
              description: result.description,
              boundingBox: result.bounding_box,
              fixPrompt: result.fix_prompt,
              usage: { inputTokens, outputTokens, model: modelId }
            };
          } else {
            log.info('🔍 [INSPECT] No errors detected');
            return { errorFound: false, usage: { inputTokens, outputTokens, model: modelId } };
          }
        } catch (parseError) {
          log.warn('⚠️ [INSPECT] Failed to parse JSON response:', parseError.message);
          return { errorFound: false, usage: { inputTokens, outputTokens, model: modelId } };
        }
      }
    }

    log.warn('⚠️ [INSPECT] No valid response from inspection');
    return { errorFound: false, usage: { inputTokens, outputTokens, model: modelId } };
  } catch (error) {
    log.error('❌ [INSPECT] Error inspecting image:', error);
    throw error;
  }
}

// Simple cache for image dimensions to avoid repeated Sharp metadata calls
const dimensionCache = new Map();
const DIMENSION_CACHE_MAX_SIZE = 100;

/**
 * Get image dimensions from base64 data (with caching)
 * @param {string} imageData - Base64 image data URL
 * @returns {Promise<{width: number, height: number}>}
 */
async function getImageDimensions(imageData) {
  // Use first 100 chars of base64 as cache key (unique enough, cheap to compute)
  const cacheKey = imageData.substring(0, 100);
  if (dimensionCache.has(cacheKey)) {
    return dimensionCache.get(cacheKey);
  }

  const base64Data = r2Lib.stripDataUriPrefix(imageData);
  const buffer = Buffer.from(base64Data, 'base64');
  const metadata = await sharp(buffer).metadata();
  const dimensions = { width: metadata.width, height: metadata.height };

  // Limit cache size to prevent memory issues
  if (dimensionCache.size >= DIMENSION_CACHE_MAX_SIZE) {
    const firstKey = dimensionCache.keys().next().value;
    dimensionCache.delete(firstKey);
  }
  dimensionCache.set(cacheKey, dimensions);

  return dimensions;
}

/**
 * Create a black/white mask from bounding box coordinates
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {number[]} boundingBox - [ymin, xmin, ymax, xmax] normalized 0-1000
 * @returns {Promise<string>} Base64 mask image (black background, white rectangle)
 */
// DEAD CODE (audit 2026-07-09): zero live callers. Part of the mask-based
// inpaint dispatcher from docs/plans/2026-03-25-grok-inpaint-repair.md that
// was built but never wired in — live inpaint is inpaintPage() → 
// editImageWithPrompt() (backend from MODEL_DEFAULTS.pageImage). Kept per
// user decision (mark, do not delete). Do NOT document as live behavior.
async function createMaskFromBoundingBox(width, height, boundingBox) {
  const [ymin, xmin, ymax, xmax] = boundingBox;

  // Convert normalized coordinates (0-1000) to pixel coordinates
  const left = Math.floor((xmin / 1000) * width);
  const top = Math.floor((ymin / 1000) * height);
  const rectWidth = Math.floor(((xmax - xmin) / 1000) * width);
  const rectHeight = Math.floor(((ymax - ymin) / 1000) * height);

  log.debug(`🎭 [MASK] Creating mask: ${width}x${height}, box: [${left},${top},${rectWidth},${rectHeight}]`);

  // Create black background
  const blackBackground = await sharp({
    create: {
      width: width,
      height: height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 }
    }
  }).png().toBuffer();

  // Create white rectangle
  const whiteRect = await sharp({
    create: {
      width: rectWidth,
      height: rectHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  }).png().toBuffer();

  // Composite white rectangle onto black background
  const maskBuffer = await sharp(blackBackground)
    .composite([{
      input: whiteRect,
      left: left,
      top: top
    }])
    .png()
    .toBuffer();

  const maskBase64 = `data:image/png;base64,${maskBuffer.toString('base64')}`;
  log.debug('🎭 [MASK] Mask created successfully');

  return maskBase64;
}


/**
 * Classify issue type from issue description text
 * Used to determine appropriate padding and model selection
 * @param {string} issue - Issue description text
 * @returns {string} Issue type: 'face', 'hand', 'anatomy', 'object', or 'default'
 */
function classifyIssueType(issue) {
  if (!issue || typeof issue !== 'string') return 'default';
  const lower = issue.toLowerCase();

  // Face/identity issues - need high-quality model + face reference
  if (lower.match(/\b(face|facial|eye|eyes|nose|mouth|expression|identity|portrait)\b/)) {
    return 'face';
  }

  // Hand issues - common AI artifact
  if (lower.match(/\b(hand|hands|finger|fingers|thumb|palm|grip|holding)\b/)) {
    return 'hand';
  }

  // Other anatomy issues
  if (lower.match(/\b(arm|arms|leg|legs|foot|feet|limb|limbs|body|torso|anatomy|anatomical)\b/)) {
    return 'anatomy';
  }

  // Object issues - props, items, weapons, etc.
  if (lower.match(/\b(object|sword|shield|weapon|item|prop|tool|hat|clothing|accessory|artifact|broken|fragmented|duplicate)\b/)) {
    return 'object';
  }

  return 'default';
}

/**
 * Apply adaptive padding to bounding box based on issue type
 * Research shows: high padding preserves context, low padding = more creativity
 * @param {number[]} bbox - [ymin, xmin, ymax, xmax] normalized 0.0-1.0
 * @param {string} issueType - Type of issue (face, hand, anatomy, object, default)
 * @returns {number[]} Padded bounding box
 */
function padBoundingBox(bbox, issueType) {
  // Padding values based on research:
  // - Face: 10% (preserve identity, don't alter too much context)
  // - Hand: 15% (need some context for fingers)
  // - Anatomy: 15% (body parts need context)
  // - Object: 25% (more context needed for object coherence)
  // - Default: 20% (balanced approach)
  const padding = {
    'face': 0.10,
    'hand': 0.15,
    'anatomy': 0.15,
    'object': 0.25,
    'default': 0.20
  };

  const pad = padding[issueType] || padding.default;
  let [ymin, xmin, ymax, xmax] = bbox;

  // Normalize to 0-1 format if in 0-1000 format (consistent with createCombinedMask)
  if (ymin > 1 || xmin > 1 || ymax > 1 || xmax > 1) {
    ymin /= 1000;
    xmin /= 1000;
    ymax /= 1000;
    xmax /= 1000;
  }

  return [
    Math.max(0, ymin - pad),  // ymin
    Math.max(0, xmin - pad),  // xmin
    Math.min(1, ymax + pad),  // ymax
    Math.min(1, xmax + pad)   // xmax
  ];
}

/**
 * Verify inpaint results using LPIPS perceptual similarity
 * Compares before/after images in the specific repaired region
 * @param {string} beforeImage - Image before inpainting
 * @param {string} afterImage - Image after inpainting
 * @param {Array} bbox - Bounding box [ymin, xmin, ymax, xmax] normalized
 * @returns {Object} { lpipsScore, interpretation, changed } or null if unavailable
 */
// DEAD CODE (audit 2026-07-09): zero live callers. Part of the mask-based
// inpaint dispatcher from docs/plans/2026-03-25-grok-inpaint-repair.md that
// was built but never wired in — live inpaint is inpaintPage() → 
// editImageWithPrompt() (backend from MODEL_DEFAULTS.pageImage). Kept per
// user decision (mark, do not delete). Do NOT document as live behavior.
async function verifyInpaintWithLPIPS(beforeImage, afterImage, bbox = null) {
  try {
    const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

    const requestBody = {
      image1: beforeImage,
      image2: afterImage,
      resize_to: 256
    };

    // Crop to specific region if bbox provided
    if (bbox && Array.isArray(bbox) && bbox.length === 4) {
      requestBody.bbox = bbox;
    }

    const response = await fetch(`${photoAnalyzerUrl}/lpips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      return null;
    }

    const result = await response.json();

    if (result.success) {
      // LPIPS interpretation for inpaint verification:
      // - Score near 0: Images nearly identical (inpaint may not have changed anything)
      // - Score 0.05-0.20: Expected range for successful repair (visible change, similar style)
      // - Score > 0.30: Significant change (could be good or bad depending on issue)
      return {
        lpipsScore: result.lpips_score,
        interpretation: result.interpretation,
        region: result.region,
        changed: result.lpips_score > 0.02  // True if meaningful change detected
      };
    }
    return null;
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED') {
      log.debug('[LPIPS VERIFY] Service not available');
    } else {
      log.debug(`[LPIPS VERIFY] Error: ${err.message}`);
    }
    return null;
  }
}

/**
 * Verify inpaint results using targeted LLM analysis
 * Uses a focused prompt to check if the specific issue was fixed
 * @param {string} beforeImage - Image before inpainting
 * @param {string} afterImage - Image after inpainting
 * @param {string} issueDescription - What the original issue was
 * @param {string} fixDescription - What the fix was supposed to do
 * @param {Array} bbox - Bounding box [ymin, xmin, ymax, xmax] normalized
 * @returns {Object} { fixed, confidence, explanation } or null
 */
// DEAD CODE (audit 2026-07-09): zero live callers. Part of the mask-based
// inpaint dispatcher from docs/plans/2026-03-25-grok-inpaint-repair.md that
// was built but never wired in — live inpaint is inpaintPage() → 
// editImageWithPrompt() (backend from MODEL_DEFAULTS.pageImage). Kept per
// user decision (mark, do not delete). Do NOT document as live behavior.
async function verifyInpaintWithLLM(beforeImage, afterImage, issueDescription, fixDescription, bbox = null) {
  try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return null;
    }

    const beforeBase64 = r2Lib.stripDataUriPrefix(beforeImage);
    const beforeMime = beforeImage.match(/^data:(image\/\w+);base64,/) ?
      beforeImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    const afterBase64 = r2Lib.stripDataUriPrefix(afterImage);
    const afterMime = afterImage.match(/^data:(image\/\w+);base64,/) ?
      afterImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Region hint for LLM
    const regionHint = bbox
      ? `Focus on the region at approximately: top ${Math.round(bbox[0] * 100)}%, left ${Math.round(bbox[1] * 100)}%, bottom ${Math.round(bbox[2] * 100)}%, right ${Math.round(bbox[3] * 100)}% of the image.`
      : '';

    const prompt = `You are verifying an image repair operation. Compare the BEFORE and AFTER images.

ORIGINAL ISSUE: ${issueDescription}
INTENDED FIX: ${fixDescription}
${regionHint}

Analyze whether the repair was successful. Consider:
1. Was the original issue actually fixed?
2. Did the fix introduce any new artifacts or problems?
3. Does the repaired area blend naturally with surrounding content?

Output JSON only:
{
  "fixed": true/false,
  "confidence": 0.0-1.0,
  "explanation": "Brief explanation of the repair result"
}`;

    const requestBody = {
      contents: [{
        parts: [
          { text: "BEFORE image:" },
          { inline_data: { mime_type: beforeMime, data: beforeBase64 } },
          { text: "AFTER image:" },
          { inline_data: { mime_type: afterMime, data: afterBase64 } },
          { text: prompt }
        ]
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 500,
        responseMimeType: 'application/json'
      }
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_DEFAULTS.utility}:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30000)
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    // Log token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    const modelId = MODEL_DEFAULTS.utility;
    log.debug(`📊 [INPAINT VERIFY] Token usage - input: ${inputTokens}, output: ${outputTokens}, model: ${modelId}`);

    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const usage = { inputTokens, outputTokens, model: modelId };

    try {
      const result = getStoryHelpers().extractJsonFromText(responseText);
      if (!result) {
        log.warn('⚠️ [INPAINT VERIFY] Could not extract JSON from response');
        return { usage };
      }
      return {
        fixed: result.fixed === true,
        confidence: parseFloat(result.confidence) || 0.5,
        explanation: result.explanation || 'No explanation provided',
        usage
      };
    } catch (parseErr) {
      log.debug(`[INPAINT VERIFY] Failed to parse response: ${parseErr.message}`);
      return { usage }; // Return usage even on parse failure
    }
  } catch (err) {
    log.debug(`[INPAINT VERIFY] Error: ${err.message}`);
    return null;
  }
}

/**
 * Comprehensive inpaint verification combining LPIPS and LLM
 * Returns verification results for dev mode display
 * @param {string} beforeImage - Image before inpainting
 * @param {string} afterImage - Image after inpainting
 * @param {Array} targets - Array of {boundingBox, issue, fixPrompt}
 * @returns {Object} { lpips, llm, success }
 */
// DEAD CODE (audit 2026-07-09): zero live callers. Part of the mask-based
// inpaint dispatcher from docs/plans/2026-03-25-grok-inpaint-repair.md that
// was built but never wired in — live inpaint is inpaintPage() → 
// editImageWithPrompt() (backend from MODEL_DEFAULTS.pageImage). Kept per
// user decision (mark, do not delete). Do NOT document as live behavior.
async function verifyInpaintResult(beforeImage, afterImage, targets) {
  if (!targets || targets.length === 0) {
    return { lpips: null, llm: null, success: true };
  }

  // Get combined bounding box from all targets
  const allBboxes = targets.map(t => t.boundingBox).filter(Boolean);
  const combinedBbox = allBboxes.length > 0 ? [
    Math.min(...allBboxes.map(b => b[0])),  // ymin
    Math.min(...allBboxes.map(b => b[1])),  // xmin
    Math.max(...allBboxes.map(b => b[2])),  // ymax
    Math.max(...allBboxes.map(b => b[3]))   // xmax
  ] : null;

  // Combine issue/fix descriptions
  const issueDescription = targets.map(t => t.issue).join('; ');
  const fixDescription = targets.map(t => t.fixPrompt).join('; ');

  // Run LPIPS and LLM verification in parallel
  const [lpipsResult, llmResult] = await Promise.all([
    verifyInpaintWithLPIPS(beforeImage, afterImage, combinedBbox),
    verifyInpaintWithLLM(beforeImage, afterImage, issueDescription, fixDescription, combinedBbox)
  ]);

  // Determine overall success
  // - LPIPS: Image should have changed (score > 0.02)
  // - LLM: Should confirm fix was applied (fixed === true)
  const lpipsSuccess = lpipsResult ? lpipsResult.changed : null;
  const llmSuccess = llmResult ? llmResult.fixed : null;

  // If both available, require both to pass; otherwise use whichever is available
  let success = true;
  if (lpipsSuccess !== null && llmSuccess !== null) {
    success = lpipsSuccess && llmSuccess;
  } else if (llmSuccess !== null) {
    success = llmSuccess;
  } else if (lpipsSuccess !== null) {
    success = lpipsSuccess;
  }

  return {
    lpips: lpipsResult,
    llm: llmResult,
    success,
    combinedBbox
  };
}

/**
 * Group fix targets by issue type for smart inpainting
 * Research: Combining unrelated regions in one mask causes artifacts
 * Face issues need high-quality model + reference, objects can use cheaper model
 *
 * Two-stage detection provides separate face_box and body_box:
 * - Face issues use faceBox (precise face region for identity preservation)
 * - Anatomy issues use bodyBox (full body context for hands/limbs)
 * - Object issues use bodyBox (more context for coherent object repair)
 *
 * @param {Array} fixTargets - Array of {boundingBox, faceBox?, bodyBox?, issue, fixPrompt}
 * @returns {Object} Grouped targets: { faceTargets, anatomyTargets, objectTargets }
 */
// DEAD CODE (audit 2026-07-09): zero live callers. Part of the mask-based
// inpaint dispatcher from docs/plans/2026-03-25-grok-inpaint-repair.md that
// was built but never wired in — live inpaint is inpaintPage() → 
// editImageWithPrompt() (backend from MODEL_DEFAULTS.pageImage). Kept per
// user decision (mark, do not delete). Do NOT document as live behavior.
function groupFixTargetsForInpainting(fixTargets) {
  const faceTargets = [];
  const anatomyTargets = [];
  const objectTargets = [];

  for (const target of fixTargets) {
    const issueType = classifyIssueType(target.issue);

    // Select the appropriate bounding box based on issue type
    // Two-stage detection provides faceBox and bodyBox separately
    let selectedBbox;
    if (issueType === 'face' && target.faceBox) {
      // Use precise face box for identity-related issues
      selectedBbox = target.faceBox;
      log.debug(`🔧 [GROUPING] Using faceBox for face issue: "${target.issue.substring(0, 40)}..."`);
    } else if (target.bodyBox) {
      // Use body box for anatomy/object issues (more context)
      selectedBbox = target.bodyBox;
      log.debug(`🔧 [GROUPING] Using bodyBox for ${issueType} issue: "${target.issue.substring(0, 40)}..."`);
    } else {
      // Fall back to generic boundingBox (legacy format or detection failed)
      selectedBbox = target.boundingBox;
      if (selectedBbox) {
        log.debug(`🔧 [GROUPING] Using fallback boundingBox for ${issueType} issue`);
      }
    }

    if (!selectedBbox) {
      log.warn(`⚠️  [GROUPING] No bounding box available for issue: "${target.issue.substring(0, 40)}..."`);
      continue;
    }

    // Apply adaptive padding to the selected bounding box
    const paddedBbox = padBoundingBox(selectedBbox, issueType);
    const paddedTarget = {
      ...target,
      boundingBox: paddedBbox,
      originalBox: selectedBbox,  // Keep original for debugging
      issueType
    };

    switch (issueType) {
      case 'face':
        faceTargets.push(paddedTarget);
        break;
      case 'hand':
      case 'anatomy':
        anatomyTargets.push(paddedTarget);
        break;
      case 'object':
      default:
        objectTargets.push(paddedTarget);
        break;
    }
  }

  log.debug(`🔧 [GROUPING] Grouped ${fixTargets.length} targets: ${faceTargets.length} face, ${anatomyTargets.length} anatomy, ${objectTargets.length} object`);

  return { faceTargets, anatomyTargets, objectTargets };
}

/**
 * Create a combined mask from multiple bounding boxes
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {Array<number[]>} boundingBoxes - Array of [ymin, xmin, ymax, xmax] normalized 0.0-1.0
 * @returns {Promise<string>} Base64 mask image (black background, white rectangles for all boxes)
 */
// DEAD CODE (audit 2026-07-09): zero live callers. Part of the mask-based
// inpaint dispatcher from docs/plans/2026-03-25-grok-inpaint-repair.md that
// was built but never wired in — live inpaint is inpaintPage() → 
// editImageWithPrompt() (backend from MODEL_DEFAULTS.pageImage). Kept per
// user decision (mark, do not delete). Do NOT document as live behavior.
async function createCombinedMask(width, height, boundingBoxes) {
  if (!boundingBoxes || boundingBoxes.length === 0) {
    throw new Error('No bounding boxes provided');
  }

  log.debug(`🎭 [MASK] Creating combined mask with ${boundingBoxes.length} regions`);

  try {
    // Create black background
    const blackBackground = await sharp({
      create: {
        width: width,
        height: height,
        channels: 3,
        background: { r: 0, g: 0, b: 0 }
      }
    }).png().toBuffer();

    // Create white rectangles for each bounding box
    const compositeInputs = [];
    for (let i = 0; i < boundingBoxes.length; i++) {
      const [ymin, xmin, ymax, xmax] = boundingBoxes[i];

      // Handle both 0.0-1.0 format (from FIX_TARGETS) and 0-1000 format (legacy)
      const scale = (ymin <= 1 && xmin <= 1 && ymax <= 1 && xmax <= 1) ? 1 : 1000;

      const left = Math.floor((xmin / scale) * width);
      const top = Math.floor((ymin / scale) * height);
      const rectWidth = Math.max(1, Math.floor(((xmax - xmin) / scale) * width));
      const rectHeight = Math.max(1, Math.floor(((ymax - ymin) / scale) * height));

      log.debug(`🎭 [MASK] Box ${i + 1}: [${left},${top},${rectWidth},${rectHeight}]`);

      // Create white rectangle for this box
      const whiteRect = await sharp({
        create: {
          width: rectWidth,
          height: rectHeight,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      }).png().toBuffer();

      compositeInputs.push({
        input: whiteRect,
        left: left,
        top: top
      });
    }

    // Composite all white rectangles onto black background
    const maskBuffer = await sharp(blackBackground)
      .composite(compositeInputs)
      .png()
      .toBuffer();

    const maskBase64 = `data:image/png;base64,${maskBuffer.toString('base64')}`;
    log.info(`🎭 [MASK] Combined mask created with ${boundingBoxes.length} regions`);

    return maskBase64;
  } catch (error) {
    log.error(`[MASK] Failed to create combined mask: ${error.message}`);
    throw new Error(`Mask generation failed for ${boundingBoxes.length} regions: ${error.message}`);
  }
}

/**
 * Black out issue regions in an image to force regeneration of broken areas.
 * Takes fix targets from quality evaluation and composites black rectangles
 * over the affected areas, choosing the most appropriate box per issue type.
 * @param {string} imageBase64 - Base64 image data (with or without data: prefix)
 * @param {Array} fixTargets - Enriched fix targets with boundingBox, faceBox, bodyBox, type
 * @param {number} padding - Padding around each region as fraction (0.05 = 5%)
 * @returns {Promise<string>} Modified image as base64 (with data: prefix)
 */
async function blackoutIssueRegions(imageBase64, fixTargets, padding = 0.05) {
  if (!fixTargets || fixTargets.length === 0) {
    log.warn('⬛ [BLACKOUT] No fix targets provided, returning original image');
    return imageBase64;
  }

  try {
    // Decode image
    const rawBase64 = r2Lib.stripDataUriPrefix(imageBase64);
    const imageBuffer = Buffer.from(rawBase64, 'base64');
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;

    log.info(`⬛ [BLACKOUT] Blacking out ${fixTargets.length} issue regions in ${width}x${height} image`);

    // Build black rectangles for each fix target
    const compositeInputs = [];
    for (let i = 0; i < fixTargets.length; i++) {
      const target = fixTargets[i];

      // Choose the most appropriate box based on issue type
      let box;
      if (target.type === 'face' && target.faceBox) {
        box = target.faceBox;
      // `accessory` / `accessory_missing` are worn on the body and mask like
      // clothing — they split off from the clothing TYPE (for score ceilings)
      // but must keep clothing's box choice.
      } else if ((target.type === 'clothing' || target.type === 'accessory' || target.type === 'accessory_missing'
                  || target.type === 'limb' || target.type === 'hand') && target.bodyBox) {
        box = target.bodyBox;
      } else {
        box = target.boundingBox || target.bodyBox || target.faceBox;
      }

      if (!box || box.length < 4) {
        log.debug(`⬛ [BLACKOUT] Target ${i + 1} has no usable box, skipping: ${target.issue?.substring(0, 50)}`);
        continue;
      }

      let [ymin, xmin, ymax, xmax] = box;

      // Handle both 0.0-1.0 format and 0-1000 format
      const scale = (ymin <= 1 && xmin <= 1 && ymax <= 1 && xmax <= 1) ? 1 : 1000;
      ymin /= scale;
      xmin /= scale;
      ymax /= scale;
      xmax /= scale;

      // Add padding (clamped to 0-1)
      const padX = (xmax - xmin) * padding;
      const padY = (ymax - ymin) * padding;
      ymin = Math.max(0, ymin - padY);
      xmin = Math.max(0, xmin - padX);
      ymax = Math.min(1, ymax + padY);
      xmax = Math.min(1, xmax + padX);

      // Convert to pixel coordinates
      const left = Math.floor(xmin * width);
      const top = Math.floor(ymin * height);
      const rectWidth = Math.max(1, Math.floor((xmax - xmin) * width));
      const rectHeight = Math.max(1, Math.floor((ymax - ymin) * height));

      log.debug(`⬛ [BLACKOUT] Target ${i + 1} (${target.type || 'unknown'}): [${left},${top},${rectWidth}x${rectHeight}] — ${target.issue?.substring(0, 60) || 'no description'}`);

      // Semi-transparent magenta overlay — preserves composition context
      // while clearly marking the area as needing regeneration
      const overlay = await sharp({
        create: {
          width: rectWidth,
          height: rectHeight,
          channels: 4,
          background: { r: 200, g: 0, b: 100, alpha: 0.6 }
        }
      }).png().toBuffer();

      compositeInputs.push({ input: overlay, left, top });
    }

    if (compositeInputs.length === 0) {
      log.warn('⬛ [BLACKOUT] No valid bounding boxes found in fix targets, returning original image');
      return imageBase64;
    }

    // Composite black rectangles onto the original image
    const resultBuffer = await sharp(imageBuffer)
      .composite(compositeInputs)
      .jpeg({ quality: 90 })
      .toBuffer();

    const resultBase64 = `data:image/jpeg;base64,${resultBuffer.toString('base64')}`;
    log.info(`⬛ [BLACKOUT] Blacked out ${compositeInputs.length}/${fixTargets.length} regions (${Math.round(resultBuffer.length / 1024)}KB)`);

    return resultBase64;
  } catch (error) {
    log.error(`⬛ [BLACKOUT] Failed to blackout issue regions: ${error.message}`);
    // Return original image on failure rather than crashing
    return imageBase64;
  }
}

/**
 * Inpaint using Runware API backend
 * Uses actual mask images (white=replace, black=preserve) instead of text coordinates.
 * Much cheaper than Gemini: ~$0.002/image (SDXL) vs ~$0.03/image
 *
 * @param {string} originalImage - Base64 original image
 * @param {Array} boundingBoxes - Array of [ymin, xmin, ymax, xmax] normalized 0-1 coordinates
 * @param {string} fixPrompt - Instruction for what to fix
 * @param {string} existingMask - Optional pre-generated mask image
 * @param {Object} options - Runware options
 * @returns {Promise<{imageData: string, usage: Object, modelId: string}|null>}
 */
// DEAD CODE (audit 2026-07-09): zero live callers. Part of the mask-based
// inpaint dispatcher from docs/plans/2026-03-25-grok-inpaint-repair.md that
// was built but never wired in — live inpaint is inpaintPage() → 
// editImageWithPrompt() (backend from MODEL_DEFAULTS.pageImage). Kept per
// user decision (mark, do not delete). Do NOT document as live behavior.
async function inpaintWithRunwareBackend(originalImage, boundingBoxes, fixPrompt, existingMask = null, options = {}) {
  try {
    const { inpaintWithRunware, downloadRunwareImage, isRunwareConfigured } = require('./runware');

    if (!isRunwareConfigured()) {
      throw new Error('Runware API key not configured. Set RUNWARE_API_KEY in environment or use INPAINT_BACKEND=gemini');
    }

    // Get image dimensions for mask generation
    const dimensions = await getImageDimensions(originalImage);
    const { width, height } = dimensions;

    // Generate mask if not provided
    let mask = existingMask;
    if (!mask) {
      log.debug(`🎭 [INPAINT-RUNWARE] Generating mask for ${boundingBoxes.length} region(s)`);
      mask = await createCombinedMask(width, height, boundingBoxes);
    }

    log.info(`🎨 [INPAINT-RUNWARE] Starting inpaint with model ${options.model || 'runware:101@1'}`);

    // Call Runware API
    const result = await inpaintWithRunware(originalImage, mask, fixPrompt, {
      model: options.model || 'runware:101@1',
      strength: 0.85,
      steps: 20,
      width: width,
      height: height
    });

    // If Runware returns a URL, download and convert to base64
    let imageData = result.imageData;
    if (imageData && !imageData.startsWith('data:')) {
      log.debug(`📥 [INPAINT-RUNWARE] Downloading result from URL...`);
      imageData = await downloadRunwareImage(imageData);
    }

    // Compress to JPEG for consistency with Gemini output
    log.debug('🗜️ [INPAINT-RUNWARE] Compressing to JPEG...');
    const compressedImageData = await compressImageToJPEG(imageData);

    log.info(`✅ [INPAINT-RUNWARE] Complete. Cost: $${result.usage?.cost?.toFixed(6) || '0.002000'}`);

    // Construct descriptive fullPrompt for display (includes bounding box info)
    const coordText = boundingBoxes.map((bbox, i) => {
      const [ymin, xmin, ymax, xmax] = bbox;
      return `Region ${i + 1}: [y: ${(ymin * 100).toFixed(0)}%-${(ymax * 100).toFixed(0)}%, x: ${(xmin * 100).toFixed(0)}%-${(xmax * 100).toFixed(0)}%]`;
    }).join('\n');
    const descriptivePrompt = `TARGET REGION(S) (mask-based):\n${coordText}\n\nREQUESTED CHANGE:\n${fixPrompt}`;

    return {
      imageData: compressedImageData,
      usage: result.usage,
      modelId: result.modelId,
      fullPrompt: descriptivePrompt
    };

  } catch (error) {
    log.error(`❌ [INPAINT-RUNWARE] Error: ${error.message}`);
    throw error;
  }
}

/**
 * Inpaint regions using Grok edit API with blackout+blend technique.
 *
 * Approach (mirrors repairCharacterMismatchWithGrok blended mode):
 * 1. White out all bounding box regions on the original image
 * 2. Send whiteout image + fix prompt to editWithGrok()
 * 3. Resize Grok result to match original dimensions
 * 4. Feathered-blend each bbox region from Grok result back onto the original (30px feather)
 *
 * @param {string} originalImage - Base64 data URI of the original image
 * @param {Array<number[]>} boundingBoxes - Array of [ymin, xmin, ymax, xmax] normalized 0-1
 * @param {string} fixPrompt - Instruction for what to fix in the regions
 * @param {Object} options - Additional options
 * @returns {Promise<{imageData: string, modelId: string, usage?: Object, fullPrompt: string}>}
 */
// DEAD CODE (audit 2026-07-09): zero live callers. Part of the mask-based
// inpaint dispatcher from docs/plans/2026-03-25-grok-inpaint-repair.md that
// was built but never wired in — live inpaint is inpaintPage() → 
// editImageWithPrompt() (backend from MODEL_DEFAULTS.pageImage). Kept per
// user decision (mark, do not delete). Do NOT document as live behavior.
async function inpaintWithGrokBackend(originalImage, boundingBoxes, fixPrompt, options = {}) {
  // 1. Create whiteout overlay on all bounding box regions
  const origBase64 = r2Lib.stripDataUriPrefix(originalImage);
  const origBuffer = Buffer.from(origBase64, 'base64');
  const metadata = await sharp(origBuffer).metadata();
  const { width, height } = metadata;

  // Build composite operations for all bounding boxes
  const composites = [];
  for (const bbox of boundingBoxes) {
    const [ymin, xmin, ymax, xmax] = bbox;
    const bx = Math.round(xmin * width);
    const by = Math.round(ymin * height);
    const bw = Math.max(1, Math.round((xmax - xmin) * width));
    const bh = Math.max(1, Math.round((ymax - ymin) * height));
    // White rectangle with 80% opacity (same as character repair outer ring)
    const whiteRect = await sharp({
      create: { width: bw, height: bh, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 204 } }
    }).png().toBuffer();
    composites.push({ input: whiteRect, left: bx, top: by });
  }

  const whiteoutBuffer = await sharp(origBuffer)
    .composite(composites)
    .jpeg({ quality: 90 })
    .toBuffer();
  const whiteoutDataUri = `data:image/jpeg;base64,${whiteoutBuffer.toString('base64')}`;

  // 2. Build prompt for Grok
  const regionDescriptions = boundingBoxes.map((bbox, idx) => {
    const [ymin, xmin, ymax, xmax] = bbox;
    return `Region ${idx + 1}: top ${Math.round(ymin * 100)}%-${Math.round(ymax * 100)}%, left ${Math.round(xmin * 100)}%-${Math.round(xmax * 100)}%`;
  }).join('\n');

  const grokPrompt = fillTemplate(LOCAL_PROMPTS.inpaintGrokRegions, {
    REGION_DESCRIPTIONS: regionDescriptions,
    FIX_PROMPT: fixPrompt,
  });

  // 3. Send to Grok — snap to the nearest SUPPORTED Grok preset (PIPE-6).
  // The old 3-way 16:9/9:16/1:1 guess turned 3:4 pages into 9:16, then the
  // fit:'fill' resize below stretched every repaired region ~33%. closestGrokAspect
  // includes 3:4/4:3/2:3/etc. so the returned image already matches the page shape.
  const aspectRatio = closestGrokAspect(width, height);
  log.info(`🔧 [INPAINT-GROK] Sending ${boundingBoxes.length} region(s) to Grok for repair (aspect: ${aspectRatio})`);

  const grokResult = await editWithGrok(grokPrompt, [whiteoutDataUri], {
    model: GROK_MODELS.STANDARD,
    aspectRatio,
    // Every repaired region is feather-blended back at the ORIGINAL scene
    // coordinates below. A centre-crop of Grok's output shifts and rescales
    // the content, so the mask would land on the wrong pixels.
    skipOutputCrop: true,
  });

  if (!grokResult?.imageData) {
    throw new Error('Grok returned no image for inpaint repair');
  }

  // 4. Feathered blend each region back onto original (same technique as character repair)
  const FEATHER_PX = 30;
  const grokBase64 = r2Lib.stripDataUriPrefix(grokResult.imageData);
  let grokBuffer = Buffer.from(grokBase64, 'base64');

  // Resize Grok result to match original dimensions if needed
  const grokMeta = await sharp(grokBuffer).metadata();
  if (grokMeta.width !== width || grokMeta.height !== height) {
    log.warn(`⚠️ [INPAINT-GROK] Grok returned ${grokMeta.width}x${grokMeta.height}, expected ${width}x${height} — resizing`);
    grokBuffer = await sharp(grokBuffer).resize(width, height, { fit: 'fill' }).jpeg({ quality: 95 }).toBuffer();
  }

  let resultBuffer = origBuffer;

  for (const bbox of boundingBoxes) {
    const [ymin, xmin, ymax, xmax] = bbox;
    // Add 10% padding for blend region
    const padX = (xmax - xmin) * 0.1;
    const padY = (ymax - ymin) * 0.1;
    const bx = Math.max(0, Math.round((xmin - padX) * width));
    const by = Math.max(0, Math.round((ymin - padY) * height));
    const bx2 = Math.min(width, Math.round((xmax + padX) * width));
    const by2 = Math.min(height, Math.round((ymax + padY) * height));
    const bw = bx2 - bx;
    const bh = by2 - by;

    if (bw <= 0 || bh <= 0) continue;

    // Extract regions from both images as raw RGB
    const origRegion = await sharp(resultBuffer)
      .extract({ left: bx, top: by, width: bw, height: bh })
      .raw().toBuffer();
    const grokRegion = await sharp(grokBuffer)
      .extract({ left: bx, top: by, width: bw, height: bh })
      .raw().toBuffer();

    // Create feathered blend: original at edges, Grok result in center
    const blended = Buffer.alloc(bw * bh * 3);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        // Distance from edge (0 at edge, 1 in center beyond feather)
        const dx = Math.min(x, bw - 1 - x) / FEATHER_PX;
        const dy = Math.min(y, bh - 1 - y) / FEATHER_PX;
        const alpha = Math.min(1, Math.min(dx, dy)); // 0=original, 1=grok
        const idx = (y * bw + x) * 3;
        for (let c = 0; c < 3; c++) {
          blended[idx + c] = Math.round(origRegion[idx + c] * (1 - alpha) + grokRegion[idx + c] * alpha);
        }
      }
    }

    // Composite blended region back onto result
    const blendedPng = await sharp(blended, { raw: { width: bw, height: bh, channels: 3 } }).png().toBuffer();
    resultBuffer = await sharp(resultBuffer)
      .composite([{ input: blendedPng, left: bx, top: by }])
      .jpeg({ quality: 95 }).toBuffer();
  }

  const finalDataUri = `data:image/jpeg;base64,${resultBuffer.toString('base64')}`;
  log.info(`✅ [INPAINT-GROK] Repair complete. ${boundingBoxes.length} region(s) blended. Cost: $${grokResult.usage?.cost || 0.02}`);

  return {
    imageData: finalDataUri,
    modelId: grokResult.modelId || 'grok-imagine',
    usage: grokResult.usage,
    fullPrompt: grokPrompt
  };
}

/**
 * Inpaint an image using TEXT-BASED region coordinates (semantic masking)
 * NOTE: Gemini 2.5 Flash Image uses natural language to identify regions.
 * We pass coordinates as text in the prompt instead of as a mask image,
 * which is more reliable when there are multiple similar elements (e.g., multiple hands).
 *
 * Supports multiple backends:
 * - 'gemini' (default): Uses text-based coordinates with Gemini API
 * - 'runware': Uses mask images with Runware API (much cheaper)
 * - 'grok': Uses blackout+blend with Grok edit API
 *
 * @param {string} originalImage - Base64 original image
 * @param {Array} boundingBoxes - Array of [ymin, xmin, ymax, xmax] normalized 0-1 coordinates
 * @param {string} fixPrompt - Instruction for what to fix
 * @param {string} maskImage - Optional mask image (required for Runware, optional for Gemini)
 * @param {Object} options - Additional options
 * @param {string} options.backend - 'gemini', 'runware', or 'grok' (default: MODEL_DEFAULTS.inpaintBackend)
 * @param {string} options.runwareModel - Runware model to use (default: 'runware:101@1' SDXL)
 * @returns {Promise<{imageData: string, usage?: Object, modelId?: string}|null>}
 */
// DEAD CODE (audit 2026-07-09): zero live callers. Part of the mask-based
// inpaint dispatcher from docs/plans/2026-03-25-grok-inpaint-repair.md that
// was built but never wired in — live inpaint is inpaintPage() → 
// editImageWithPrompt() (backend from MODEL_DEFAULTS.pageImage). Kept per
// user decision (mark, do not delete). Do NOT document as live behavior.
async function inpaintWithMask(originalImage, boundingBoxes, fixPrompt, maskImage = null, options = {}) {
  const {
    backend = MODEL_DEFAULTS.inpaintBackend || 'runware',
    runwareModel = 'runware:101@1'
  } = options;

  log.debug(`🔧 [INPAINT] Using backend: ${backend}`);

  // Route to Runware if configured
  if (backend === 'runware') {
    return inpaintWithRunwareBackend(originalImage, boundingBoxes, fixPrompt, maskImage, { model: runwareModel });
  }

  // Route to Grok if configured
  if (backend === 'grok') {
    return inpaintWithGrokBackend(originalImage, boundingBoxes, fixPrompt, options);
  }

  // Default: Gemini backend
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key not configured');
    }

    // Build coordinate descriptions for each region
    const regionDescriptions = boundingBoxes.map((bbox, idx) => {
      const [ymin, xmin, ymax, xmax] = bbox;
      // Convert to percentages for clearer instruction
      const top = Math.round(ymin * 100);
      const left = Math.round(xmin * 100);
      const bottom = Math.round(ymax * 100);
      const right = Math.round(xmax * 100);
      return `Region ${idx + 1}: from top ${top}% to ${bottom}%, left ${left}% to ${right}%`;
    });

    const coordText = regionDescriptions.join('\n');
    log.debug(`🔧 [INPAINT] Inpainting ${boundingBoxes.length} region(s) with text coordinates`);
    log.debug(`🔧 [INPAINT] Regions:\n${coordText}`);
    log.debug(`🔧 [INPAINT] Fix prompt: "${fixPrompt}"`);

    // Extract base64 and mime type for original image
    const origBase64 = r2Lib.stripDataUriPrefix(originalImage);
    const origMimeType = originalImage.match(/^data:(image\/\w+);base64,/) ?
      originalImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Build the inpainting prompt with TEXT-BASED coordinates
    // This avoids confusion when multiple images are sent
    const inpaintPrompt = fillTemplate(PROMPT_TEMPLATES.inpainting || `Edit this image. Make changes ONLY in the specified region(s).

TARGET REGION(S) TO EDIT:
{REGIONS}

WHAT TO FIX IN THESE REGIONS:
{FIX_PROMPT}

IMPORTANT INSTRUCTIONS:
- ONLY modify the content within the specified coordinate regions
- Keep everything outside these regions EXACTLY the same
- Maintain the same art style and color palette
- Make minimal changes - just fix the specific issues mentioned`, {
      REGIONS: coordText,
      FIX_PROMPT: fixPrompt
    });

    // Build parts array: prompt + ONLY the original image
    // NOTE: We do NOT send the mask as an image - coordinates are in the text prompt
    const parts = [
      { text: inpaintPrompt },
      {
        inline_data: {
          mime_type: origMimeType,
          data: origBase64
        }
      }
    ];

    // Use page image model for editing with retry for socket errors
    const modelId = MODEL_DEFAULTS.pageImage;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const systemInstruction = getImageSystemInstruction();
    const data = await withRetry(async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(systemInstruction && { systemInstruction }),
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            temperature: 0.6,
            ...(modelSupportsThinking(modelId) && { thinkingConfig: { includeThoughts: true } })
          }
        })
      });

      if (!response.ok) {
        const error = await response.text();
        log.error('❌ [INPAINT] Gemini API error:', error);
        const err = new Error(`Gemini API error: ${response.status}`);
        err.status = response.status;
        throw err;
      }

      return response.json();
    }, { maxRetries: 2, baseDelay: 2000 });

    // Extract the edited image from the response
    if (data.candidates && data.candidates[0]?.content?.parts) {
      const responseParts = data.candidates[0].content.parts;

      // Extract token usage from response
      const usageMetadata = data.usageMetadata || {};
      const usage = {
        input_tokens: usageMetadata.promptTokenCount || 0,
        output_tokens: usageMetadata.candidatesTokenCount || 0,
        thinking_tokens: usageMetadata.thoughtsTokenCount || 0
      };

      // Extract thinking text
      const thinkingText = extractThinkingFromParts(responseParts, 'INPAINT');

      for (const part of responseParts) {
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData && inlineData.data) {
          const respMimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
          const rawImageData = `data:${respMimeType};base64,${inlineData.data}`;

          // Compress inpainted image to JPEG (same as initial generation)
          log.debug('🗜️  [INPAINT] Compressing repaired image to JPEG...');
          const compressedImageData = await compressImageToJPEG(rawImageData);

          log.info(`✅ [INPAINT] Successfully inpainted image (tokens: ${usage.input_tokens} in, ${usage.output_tokens} out)`);
          return { imageData: compressedImageData, thinkingText, usage, modelId, fullPrompt: inpaintPrompt };
        }
      }
    }

    log.warn('⚠️ [INPAINT] No edited image in response');
    return null;
  } catch (error) {
    log.error('❌ [INPAINT] Error inpainting image:', error);
    throw error;
  }
}

module.exports = {
  inspectImageForErrors,
  getImageDimensions,
  createMaskFromBoundingBox,
  classifyIssueType,
  padBoundingBox,
  verifyInpaintWithLPIPS,
  verifyInpaintWithLLM,
  verifyInpaintResult,
  groupFixTargetsForInpainting,
  createCombinedMask,
  blackoutIssueRegions,
  inpaintWithRunwareBackend,
  inpaintWithGrokBackend,
  inpaintWithMask,
};
