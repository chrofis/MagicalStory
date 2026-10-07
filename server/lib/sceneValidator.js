/**
 * Scene Composition Validator
 *
 * Validates scene composition by generating a cheap preview image and
 * comparing what was requested vs what was rendered using vision analysis.
 *
 * Flow:
 * 1. Generate cheap preview (Runware Schnell ~$0.0006)
 * 2. Vision model describes geometric composition (unbiased)
 * 3. Compare scene JSON vs image description for composition issues
 * 4. Return issues for repair by caller
 *
 * Total cost: ~$0.002/scene
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateWithRunware, RUNWARE_MODELS, isRunwareConfigured } = require('./runware');
const { callTextModel } = require('./textModels');
const { EVAL_TEMPERATURE } = require('../config/models');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { log } = require('../utils/logger');
const { expandPositionAbbreviations, stripEntityIds, buildHairDescription } = require('./storyHelpers');
const { getPhysical } = require('./characterPhysical');
const { buildClothingDescription } = require('./entityConsistency');

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Eval calls had no timeout — a hung provider connection froze the whole job
// forever (stuck-at-51% incident, 2026-07-07). The SDK aborts after this, the
// error propagates, and callers skip the eval instead of hanging.
const EVAL_REQUEST_OPTIONS = { timeout: 120000 };
const { MODEL_DEFAULTS, resolveSceneValidationModel, GROK_VISION_FALLBACK, calculateTextCost } = require('../config/models');
const { geminiUsage } = require('./providerUsage');
const VISION_MODEL = MODEL_DEFAULTS.qualityEval || 'gemini-2.0-flash';
const COMPARISON_MODEL = MODEL_DEFAULTS.qualityEval || 'gemini-2.0-flash';

// A vision call's usage in the pipeline's shape, priced from MODEL_PRICING.
// Replaces a hardcoded $0.15/$0.60 per 1M estimate that also ignored the
// model's thinking tokens (billed as output, several times the answer).
function pricedUsage(usageMetadata, modelId) {
  const usage = geminiUsage(usageMetadata);
  return {
    ...usage,
    tokens: usage.input_tokens + usage.output_tokens + usage.thinking_tokens,
    estimatedCost: calculateTextCost(modelId, usage),
  };
}

// Step 1: Vision model describes what it sees (no scene description provided)
const IMAGE_DESCRIPTION_PROMPT = `Describe ONLY the geometric composition of this image. For each person visible:

1. **Position in frame**: left, center, right, foreground, midground, background
2. **Body orientation**: Which way is their TORSO facing? (toward camera, away from camera, facing left, facing right, profile)
3. **Face direction**: Which way is their HEAD/FACE turned? (toward camera, away, left, right, up, down)
4. **Arm pointing**: If arm is extended, what DIRECTION is it pointing? (left, right, up, forward, at specific object)

Also note:
- Where are KEY LANDMARKS positioned? (mountain on left/center/right, etc.)
- How many people are visible with faces? (count)

IGNORE and do not mention:
- Eye state (open/closed)
- Facial expressions
- Hand positions (pockets, clasped, etc.) unless arm is extended pointing
- Clothing details
- Age or appearance

Keep it brief. Only geometric facts.`;

// Step 2: Compare scene description vs image description
const COMPARISON_PROMPT = `Compare GEOMETRIC COMPOSITION only.

You must evaluate these 17 checks. For each check, return a result object.

## THE 17 COMPOSITION CHECKS

1. **Scale Feasibility**: Camera distance vs detail needed
   - EXTREME WIDE = silhouettes only, NO faces
   - WIDE = body language, NO expressions
   - MEDIUM = expressions OK, hand positions OK
   - If scene requests expressions at WIDE/EXTREME WIDE scale = FAIL

2. **Object Orientation & Placement**: Is each object positioned precisely?
   - Can artist point to exactly where it goes in frame?
   - Is horizontal position clear? (left/center/right)
   - Is depth clear? (foreground/middle ground/background)

3. **Action-Object Compatibility**: Do actions make sense with objects?
   - Pulling horizontal trap door = squat and lift UP
   - Pulling vertical door = stand and pull TOWARD

4. **Pointing/Gaze Geometry (CRITICAL)**: Can character physically point at target?
   - Facing camera + pointing at background = IMPOSSIBLE
   - Facing camera + pointing at foreground = OK
   - Facing away + pointing forward = OK for background targets
   - Character's arm direction must match target position

5. **Camera-View Compatibility**: Can we see expressions given camera angle?
   - BACK view = no facial expressions possible
   - SIDE profile = limited expression
   - FRONT = full expressions OK

6. **Character Differentiation**: Each character has UNIQUE pose?
   - No two characters doing identical gesture

7. **Physics Check**: Ropes taut? Heavy = straining posture?

8. **Weather Consistency**: Indoor vs outdoor weather visibility
   - Indoor + "snow falling on characters" = IMPOSSIBLE
   - Indoor + "snow through window" = OK

9. **Distance Separation**: Characters meant to be far apart actually separated?

10. **Location Continuity**: Setting matches previous scenes?

11. **Story Text Fidelity**: Scene matches the input story text intent?

12. **Linear Space Consistency**: Path orientation matches character positions?

13. **Shared Object Interactions**: Multiple characters on same object correctly positioned?

14. **Obstacle Logic**: Blocking objects actually block (span width, too large to pass)?

15. **Holding Inventory**: Character hands holding correct items?

16. **Background Feasibility**: All background elements visible from this viewpoint?

17. **Character Count**: More than 3 main characters with visible faces?

---

## INPUT

**SCENE JSON (what we requested):**
"""
{SCENE_JSON}
"""

**IMAGE DESCRIPTION (what vision model observed):**
"""
{IMAGE_DESCRIPTION}
"""

---

## OUTPUT FORMAT

Return JSON:
{
  "checks": [
    {
      "checkNumber": 1,
      "checkName": "scaleFeasibility",
      "passed": true/false,
      "severity": "critical | major | minor",
      "requested": "what the scene JSON specified",
      "observed": "what the image shows",
      "issue": "description of problem (null if passed)"
    }
  ],
  "compositionIssues": [
    {
      "type": "pointing_impossible | scale_mismatch | expression_not_visible | position_mismatch | etc",
      "checkNumber": 4,
      "description": "The geometric problem",
      "requested": "Required orientation/position",
      "observed": "Actual orientation/position",
      "severity": "critical | major | minor"
    }
  ],
  "passesCompositionCheck": true/false,
  "summary": "Brief geometric assessment"
}

CRITICAL issues (must fail):
- Pointing paradox (facing camera, pointing at background)
- Expression requested but back is to camera
- More than 3 characters with visible faces

Return ONLY valid JSON.`;

/**
 * Generate a cheap preview image using Runware Schnell
 *
 * @param {Object} sceneJson - Parsed scene description JSON
 * @param {Object} options - Generation options
 * @returns {Promise<{imageData: string, imageBase64: string, usage: Object}>}
 */
async function generateCheapPreview(sceneJson, options = {}) {
  const {
    model = RUNWARE_MODELS.FLUX_SCHNELL,
    width = 768,
    height = 768
  } = options;

  if (!isRunwareConfigured()) {
    throw new Error('Runware not configured - cannot generate preview');
  }

  // Build a simplified prompt from the scene JSON
  const prompt = buildPreviewPrompt(sceneJson);

  log.debug(`[SCENE-VALIDATOR] Generating preview (${prompt.length} chars): ${prompt.substring(0, 100)}...`);

  const startTime = Date.now();
  const result = await generateWithRunware(prompt, {
    model,
    width,
    height,
    steps: 4  // Schnell needs only 4 steps
  });

  const elapsed = Date.now() - startTime;
  log.debug(`[SCENE-VALIDATOR] Preview generated in ${elapsed}ms, cost: $${result.usage.cost.toFixed(6)}`);

  return {
    imageData: result.imageData,
    imageBase64: result.imageBase64,
    usage: result.usage,
    prompt
  };
}

/**
 * Build a simplified prompt from scene JSON for preview generation
 */
function buildPreviewPrompt(sceneJson) {
  const parts = [];

  // Setting
  if (sceneJson.setting) {
    const s = sceneJson.setting;
    parts.push(`${s.location || 'Scene'}: ${s.description || ''}`);
    if (s.lighting) parts.push(s.lighting);
    if (s.weather) parts.push(s.weather);
  }

  // Image summary (most important)
  if (sceneJson.imageSummary) {
    parts.push(sceneJson.imageSummary);
  }

  // Characters with positions (expand abbreviations like MC -> middle-center midground)
  if (sceneJson.characters && sceneJson.characters.length > 0) {
    for (const char of sceneJson.characters) {
      const charParts = [char.name];
      if (char.position) charParts.push(`at ${expandPositionAbbreviations(char.position)}`);
      if (char.pose) charParts.push(char.pose);
      if (char.action) charParts.push(char.action);
      parts.push(charParts.join(', '));
    }
  }

  // Objects (expand position abbreviations)
  if (sceneJson.objects && sceneJson.objects.length > 0) {
    for (const obj of sceneJson.objects) {
      const expandedPos = expandPositionAbbreviations(obj.position) || 'in scene';
      parts.push(`${obj.name} at ${expandedPos}`);
    }
  }

  // Truncate for Runware (3000 char limit)
  const fullPrompt = parts.join('. ');
  return fullPrompt.length > 2900 ? fullPrompt.substring(0, 2900) + '...' : fullPrompt;
}

/**
 * Ask vision model to describe what it sees in an image
 *
 * @param {string} imageData - Image as data URI or base64
 * @returns {Promise<{description: string, usage: Object}>}
 */
async function describeImage(imageData) {
  log.debug('[SCENE-VALIDATOR] Vision model describing image...');

  const model = genAI.getGenerativeModel({ model: VISION_MODEL, generationConfig: { temperature: EVAL_TEMPERATURE } }, EVAL_REQUEST_OPTIONS);
  const startTime = Date.now();

  // Convert image to base64 if needed
  let imageBase64 = imageData;
  if (imageData.startsWith('data:')) {
    imageBase64 = imageData.split(',')[1];
  }

  const result = await model.generateContent([
    IMAGE_DESCRIPTION_PROMPT,
    { inlineData: { mimeType: 'image/png', data: imageBase64 } }
  ]);

  const elapsed = Date.now() - startTime;
  const text = result.response.text();

  const usage = { ...pricedUsage(result.response.usageMetadata, VISION_MODEL), elapsed };

  log.debug(`[SCENE-VALIDATOR] Description complete in ${elapsed}ms, tokens: ${usage.tokens}`);

  return {
    description: text,
    usage
  };
}

/**
 * Format character traits and clothing for the generated image analysis prompt
 *
 * @param {Array} characters - Array of character objects with traits
 * @param {Object} clothingRequirements - Per-character clothing info (optional)
 * @returns {string} Formatted character info for prompt
 */
function formatCharacterContext(characters, clothingRequirements = {}) {
  if (!characters || characters.length === 0) {
    return 'No character information provided.';
  }

  return characters.map(char => {
    // NO DEFAULT CLOTHING. `_currentClothing` is stamped per page by
    // buildSceneClothingRequirements; its absence means the caller handed over
    // the STORY-level blob. The old `|| 'standard'` then resolved to a category
    // this story may not even use, which fell through to the character-level
    // avatars wardrobe — an outfit from an unrelated earlier story — and that
    // text propagated into the iterate rewrite and got rendered (staging
    // job_1786053708336_8cdsca519 p10: a summer story regenerated in a winter
    // hoodie). Guessing an outfit is worse than not running: throw.
    const clothing = clothingRequirements[char.name]?._currentClothing;
    if (!clothing) {
      throw new Error(`[SCENE-VALIDATOR] ${char.name}: no _currentClothing in clothingRequirements — pass the per-page view (buildSceneClothingRequirements), never the story-level blob. Refusing to guess an outfit.`);
    }
    // Per-story clothing is the source of truth. Use the SAME resolver as image
    // generation, and refuse the result if it can't name the outfit — an
    // "unknown clothing" placeholder in the analysis is the same guess by
    // another name.
    const clothingDesc = buildClothingDescription(char, clothing, null, clothingRequirements);
    if (!clothingDesc) {
      throw new Error(`[SCENE-VALIDATOR] ${char.name}: clothing category "${clothing}" has no description in this story's clothingRequirements. Refusing to guess an outfit.`);
    }
    const physical = getPhysical(char);

    const traits = [];
    const hairDesc = buildHairDescription(physical, char.physicalTraitsSource);
    if (hairDesc) traits.push(`${hairDesc} hair`);
    if (physical.eyeColor) traits.push(`${physical.eyeColor} eyes`);
    if (physical.build) traits.push(`${physical.build} build`);
    if (char.age) traits.push(`age: ${char.age}`);

    return `- **${char.name}**: ${traits.join(', ')}. Currently wearing: ${clothingDesc}`;
  }).join('\n');
}

/**
 * Format visual bible landmarks/objects for the generated image analysis prompt
 *
 * @param {Object} visualBible - Visual bible with landmarks, objects, animals
 * @returns {string} Formatted landmark info for prompt
 */
function formatLandmarkContext(visualBible) {
  if (!visualBible) {
    return 'None specified.';
  }

  const items = [];

  if (visualBible.landmarks) {
    for (const [id, landmark] of Object.entries(visualBible.landmarks)) {
      items.push(`- ${landmark.name || id}: ${landmark.description || 'landmark'}`);
    }
  }

  if (visualBible.objects) {
    for (const [id, obj] of Object.entries(visualBible.objects)) {
      items.push(`- ${obj.name || id}: ${obj.description || 'object'}`);
    }
  }

  if (visualBible.animals) {
    for (const [id, animal] of Object.entries(visualBible.animals)) {
      // A creature's description states no size (cells get no size,
      // 2026-09-23); the scale it used to carry is added back here.
      const { withScaleNote } = require('./visualBible');
      items.push(`- ${animal.name || id}: ${withScaleNote(animal.description, animal) || 'animal'}`);
    }
  }

  return items.length > 0 ? items.join('\n') : 'None specified.';
}

/**
 * Analyze a generated story image for composition and character placement
 *
 * @param {string} imageData - Image as data URI or base64
 * @param {Array} characters - Array of character objects with traits (optional)
 * @param {Object} visualBible - Visual bible with landmarks/objects (optional)
 * @param {Object} clothingRequirements - Per-character clothing info (optional)
 * @returns {Promise<{description: string, usage: Object}>}
 */
async function analyzeGeneratedImage(imageData, characters = null, visualBible = null, clothingRequirements = null) {
  log.debug('[SCENE-VALIDATOR] Analyzing generated image with character context...');

  const model = genAI.getGenerativeModel({ model: VISION_MODEL, generationConfig: { temperature: EVAL_TEMPERATURE } }, EVAL_REQUEST_OPTIONS);
  const startTime = Date.now();

  // Build character info section
  const characterInfo = characters
    ? formatCharacterContext(characters, clothingRequirements || {})
    : 'No character information provided.';

  // Build landmark info section
  const landmarkInfo = formatLandmarkContext(visualBible);

  // Fill template
  const template = PROMPT_TEMPLATES.generatedImageAnalysis;
  if (!template) {
    log.warn('[SCENE-VALIDATOR] Generated image analysis prompt not loaded, falling back to basic description');
    return describeImage(imageData);
  }

  const prompt = fillTemplate(template, {
    CHARACTER_INFO: characterInfo,
    LANDMARK_INFO: landmarkInfo
  });

  // Convert image to base64 if needed
  let imageBase64 = imageData;
  if (imageData.startsWith('data:')) {
    imageBase64 = imageData.split(',')[1];
  }

  const result = await model.generateContent([
    prompt,
    { inlineData: { mimeType: 'image/png', data: imageBase64 } }
  ]);

  const elapsed = Date.now() - startTime;
  const text = result.response.text();

  const usage = { ...pricedUsage(result.response.usageMetadata, VISION_MODEL), elapsed };

  log.debug(`[SCENE-VALIDATOR] Generated image analysis complete in ${elapsed}ms, tokens: ${usage.tokens}`);

  return {
    description: text,
    usage
  };
}

/**
 * Build a simple preview prompt from scene hint (before scene expansion)
 *
 * @param {string} sceneHint - Raw scene hint from outline
 * @param {string[]} characterNames - List of character names in the scene
 * @returns {string} Simple prompt for preview generation
 */
function buildSimplePreviewPrompt(sceneHint, characterNames = []) {
  let prompt = sceneHint;
  if (characterNames.length > 0) {
    prompt += `. Characters: ${characterNames.join(', ')}`;
  }
  // Runware has 3000 char limit
  return prompt.length > 2900 ? prompt.substring(0, 2900) + '...' : prompt;
}

/**
 * Generate cheap preview and describe it (no validation/repair)
 * Used as input to scene expansion prompt to improve composition
 *
 * @param {string} sceneHint - Raw scene hint from outline
 * @param {string[]} characterNames - List of character names in the scene
 * @returns {Promise<{previewImage: string, previewPrompt: string, composition: string, usage: Object}>}
 */
async function generatePreviewFeedback(sceneHint, characterNames = []) {
  if (!isRunwareConfigured()) {
    throw new Error('Runware not configured - cannot generate preview');
  }

  // Build simple prompt from scene hint
  const prompt = buildSimplePreviewPrompt(sceneHint, characterNames);

  log.debug(`[SCENE-VALIDATOR] Generating preview feedback (${prompt.length} chars): ${prompt.substring(0, 100)}...`);

  // Generate cheap preview with Schnell
  const startTime = Date.now();
  const preview = await generateWithRunware(prompt, {
    model: RUNWARE_MODELS.FLUX_SCHNELL,
    width: 768,
    height: 768,
    steps: 4
  });

  const previewElapsed = Date.now() - startTime;
  log.debug(`[SCENE-VALIDATOR] Preview generated in ${previewElapsed}ms, cost: $${preview.usage.cost.toFixed(6)}`);

  // Describe what the image shows (unbiased composition analysis)
  const description = await describeImage(preview.imageData);

  log.debug(`[SCENE-VALIDATOR] Preview feedback complete: ${description.description.substring(0, 100)}...`);

  return {
    previewImage: preview.imageData,
    previewPrompt: prompt,
    composition: description.description,
    usage: {
      previewCost: preview.usage.cost,
      visionCost: description.usage.estimatedCost,
      totalCost: preview.usage.cost + description.usage.estimatedCost
    }
  };
}

/**
 * Compare scene JSON vs image description to find composition issues
 *
 * @param {Object|string} sceneJson - Scene description JSON (object or string)
 * @param {string} imageDescription - What the vision model observed
 * @returns {Promise<{checks: Array, compositionIssues: Array, passesCompositionCheck: boolean, summary: string, usage: Object}>}
 */
async function validateComposition(sceneJson, imageDescription) {
  log.debug('[SCENE-VALIDATOR] Comparing scene vs image...');

  const model = genAI.getGenerativeModel({ model: COMPARISON_MODEL, generationConfig: { temperature: EVAL_TEMPERATURE } }, EVAL_REQUEST_OPTIONS);
  const startTime = Date.now();

  // Format scene JSON for the prompt
  const sceneJsonStr = typeof sceneJson === 'string' ? sceneJson : JSON.stringify(sceneJson, null, 2);

  // fillTemplate — global + $-safe (sceneJsonStr is a JSON payload; a
  // string .replace would mangle any $-sequence inside it).
  const fullPrompt = fillTemplate(COMPARISON_PROMPT, {
    SCENE_JSON: sceneJsonStr,
    IMAGE_DESCRIPTION: imageDescription,
  });

  const result = await model.generateContent(fullPrompt);

  const elapsed = Date.now() - startTime;
  const text = result.response.text();

  // Parse JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    log.warn(`[SCENE-VALIDATOR] Failed to parse comparison response: ${text.substring(0, 200)}`);
    return {
      checks: [],
      compositionIssues: [],
      passesCompositionCheck: true,
      summary: 'Failed to parse validation response',
      usage: { tokens: 0, estimatedCost: 0, elapsed },
      error: 'Failed to parse response'
    };
  }

  let analysis;
  try {
    analysis = JSON.parse(jsonMatch[0]);
  } catch (err) {
    log.warn(`[SCENE-VALIDATOR] JSON parse error: ${err.message}`);
    return {
      checks: [],
      compositionIssues: [],
      passesCompositionCheck: true,
      summary: 'Failed to parse validation JSON',
      usage: { tokens: 0, estimatedCost: 0, elapsed },
      error: err.message
    };
  }

  const usage = { ...pricedUsage(result.response.usageMetadata, COMPARISON_MODEL), elapsed };

  log.debug(`[SCENE-VALIDATOR] Comparison complete in ${elapsed}ms, tokens: ${usage.tokens}`);

  return {
    checks: analysis.checks || [],
    compositionIssues: analysis.compositionIssues || [],
    passesCompositionCheck: analysis.passesCompositionCheck !== false,
    summary: analysis.summary || '',
    usage
  };
}

/**
 * Full validation pipeline: generate preview, describe, validate
 *
 * @param {Object|string} sceneJson - Scene description JSON
 * @param {Object} options - Options for preview generation
 * @returns {Promise<{imageDescription: string, checks: Array, compositionIssues: Array, passesCompositionCheck: boolean, summary: string, previewImage: string, usage: Object}>}
 */
async function validateScene(sceneJson, options = {}) {
  const parsed = typeof sceneJson === 'string' ? JSON.parse(sceneJson) : sceneJson;

  // Step 1: Generate cheap preview
  const preview = await generateCheapPreview(parsed, options);

  // Step 2: Describe what the image shows (unbiased)
  const imageDesc = await describeImage(preview.imageData);

  // Step 3: Compare scene JSON vs image description
  const comparison = await validateComposition(parsed, imageDesc.description);

  // Combine usage stats
  const totalUsage = {
    previewCost: preview.usage.cost,
    // Normalised { input_tokens, output_tokens, thinking_tokens } per call —
    // what the pipeline's addUsage books (it read a Gemini-shaped object and
    // recorded 0 tokens before).
    visionUsage: imageDesc.usage,
    visionCost: imageDesc.usage.estimatedCost,
    comparisonUsage: comparison.usage,
    comparisonCost: comparison.usage.estimatedCost,
    totalCost: preview.usage.cost + imageDesc.usage.estimatedCost + comparison.usage.estimatedCost
  };

  return {
    imageDescription: imageDesc.description,
    checks: comparison.checks,
    compositionIssues: comparison.compositionIssues,
    passesCompositionCheck: comparison.passesCompositionCheck,
    summary: comparison.summary,
    previewImage: preview.imageData,
    previewPrompt: preview.prompt,
    usage: totalUsage
  };
}

/**
 * Check if scene validation is available (requires Runware and Gemini)
 */
function isValidationAvailable() {
  return isRunwareConfigured() && !!process.env.GEMINI_API_KEY;
}

/**
 * Repair scene description based on detected composition issues
 *
 * @param {Object|string} sceneJson - Original scene description JSON
 * @param {string} imageDescription - What the vision model observed
 * @param {Array} compositionIssues - List of issues from validateComposition
 * @returns {Promise<{fixes: Array, correctedScene: Object, usage: Object}>}
 */
async function repairScene(sceneJson, imageDescription, compositionIssues) {
  log.debug('[SCENE-VALIDATOR] Repairing scene...');

  const startTime = Date.now();

  // Format scene JSON for the prompt
  const sceneJsonStr = typeof sceneJson === 'string' ? sceneJson : JSON.stringify(sceneJson, null, 2);

  // Format composition issues for the prompt
  const issuesText = compositionIssues.map((issue, i) =>
    `${i + 1}. [${(issue.severity || 'UNKNOWN').toUpperCase()}] ${issue.type || issue.checkName}\n   ${issue.description || issue.issue}\n   Requested: ${issue.requested}\n   Observed: ${issue.observed}`
  ).join('\n\n');

  // Load and fill the repair prompt template
  const template = PROMPT_TEMPLATES.sceneRepair;
  if (!template) {
    log.error('[SCENE-VALIDATOR] Scene repair prompt not loaded');
    return {
      fixes: [],
      correctedScene: null,
      usage: { tokens: 0, cost: 0 },
      error: 'Repair prompt not loaded'
    };
  }

  const repairPrompt = fillTemplate(template, {
    ORIGINAL_SCENE: sceneJsonStr,
    IMAGE_DESCRIPTION: imageDescription,
    COMPOSITION_ISSUES: issuesText
  });

  // Call Claude to generate the repair
  const result = await callTextModel(repairPrompt, null, resolveSceneValidationModel(), { prefill: '{', usageLabel: 'scene_validation' });

  const elapsed = Date.now() - startTime;
  const text = result.text;

  // Parse JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    log.warn(`[SCENE-VALIDATOR] Failed to parse repair response: ${text.substring(0, 200)}`);
    return {
      fixes: [],
      correctedScene: null,
      usage: result.usage,
      error: 'Failed to parse repair response'
    };
  }

  let repair;
  try {
    repair = JSON.parse(jsonMatch[0]);
  } catch (err) {
    // Try to fix common JSON issues (unescaped newlines in strings)
    let fixedJson = jsonMatch[0]
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');

    try {
      repair = JSON.parse(fixedJson);
      log.debug('[SCENE-VALIDATOR] Fixed malformed JSON');
    } catch (err2) {
      log.warn(`[SCENE-VALIDATOR] JSON parse error: ${err.message}`);
      return {
        fixes: [],
        correctedScene: null,
        usage: result.usage,
        error: err.message
      };
    }
  }

  log.debug(`[SCENE-VALIDATOR] Repair complete in ${elapsed}ms, ${repair.fixes?.length || 0} fixes applied`);

  return {
    fixes: repair.fixes || [],
    correctedScene: repair.correctedScene || null,
    usage: result.usage
  };
}

/**
 * Full validation and repair pipeline
 *
 * @param {Object|string} sceneJson - Scene description JSON
 * @param {Object} options - Options for validation
 * @returns {Promise<{finalScene: Object, wasRepaired: boolean, validation: Object, repair: Object, usage: Object}>}
 */
async function validateAndRepairScene(sceneJson, options = {}) {
  const parsed = typeof sceneJson === 'string' ? JSON.parse(sceneJson) : sceneJson;

  // Step 1-3: Validate scene
  const validation = await validateScene(parsed, options);

  // Step 4: Repair if issues found
  let finalScene = parsed;
  let repair = null;

  if (!validation.passesCompositionCheck && validation.compositionIssues.length > 0) {
    log.debug(`[SCENE-VALIDATOR] Found ${validation.compositionIssues.length} issues, attempting repair...`);

    repair = await repairScene(parsed, validation.imageDescription, validation.compositionIssues);

    if (repair.correctedScene) {
      finalScene = repair.correctedScene;
      log.info(`[SCENE-VALIDATOR] Scene repaired with ${repair.fixes.length} fixes`);
    } else {
      log.warn('[SCENE-VALIDATOR] Repair failed, using original scene');
    }
  }

  // Combine usage stats
  const totalUsage = {
    ...validation.usage,
    repairUsage: repair?.usage || null,
    totalCost: validation.usage.totalCost + (repair?.usage?.cost || 0)
  };

  return {
    finalScene,
    wasRepaired: repair?.correctedScene != null,
    validation,
    repair,
    usage: totalUsage
  };
}

/**
 * Evaluate semantic fidelity - does the image correctly depict the story text?
 * Checks action direction, relationships, who does what to whom.
 *
 * @param {string} imageData - Image as data URI or base64
 * @param {string} storyText - The story text this image should depict
 * @param {string} imagePrompt - The prompt used to generate this image
 * @param {string} sceneHint - Direct statement of what image should show (most authoritative)
 * @returns {Promise<{score: number, verdict: string, semanticIssues: Array, usage: Object}>}
 */
/**
 * The semantic judge's prompt, built. Split out of `evaluateSemanticFidelity`
 * so the BUILT prompt — not the template, not a replica of the fill — can be
 * asserted without a model call. Pure.
 *
 * @param {string} template - PROMPT_TEMPLATES.imageSemantic, or an A/B override
 * @param {object} parts - the per-page inputs, already resolved by the caller
 * @param {'light'|'full'} level - Gemini-safety sanitisation level
 */
/**
 * The PAIRED RE-JUDGE block (A2, owner 2026-10-07), shown only when a repaired version is judged
 * beside the version it was repaired from. '' on every other call, so the happy-path prompt is
 * the template with one empty line. Pure.
 *
 * @param {{imageData: string, findings: Array<{id,severity,type,character,description}>}|null} parent
 */
function buildParentCompareBlock(parent) {
  if (!parent || !parent.imageData) return '';
  const list = (parent.findings || []).map(f =>
    `- ${f.id} [${f.severity}] ${f.type ? `(${f.type}) ` : ''}${f.character ? `${f.character}: ` : ''}${f.description}`);
  return [
    '**PARENT PICTURE (REPAIR CHECK):** this picture is a repair of an earlier picture, attached SECOND. Judge the FIRST picture only, by every rule here; the second is for comparison and is never itself judged. The earlier picture was found to have:',
    list.length ? list.join('\n') : '- (no findings recorded)',
    'Add `parent_findings` to the JSON: one entry `{"id": "P1", "status": "fixed" | "still_present"}` for each finding above, answered from what the two pictures show. Add `also_in_parent` to EVERY `fixable_issues` entry: `true` when the same defect is visible in the second picture, else `false`.',
  ].join('\n');
}

function buildSemanticPrompt(template, { storyText, sceneHint, imagePrompt, interactionsBlock, elementsBlock, declaredLight = '', evalContext = {} } = {}, level = 'light') {
  const { sanitizeForGemini } = require('./images');
  const clean = (text) => text ? sanitizeForGemini(stripEntityIds(text), level) : null;
  return fillTemplate(template, {
    STORY_TEXT: clean(storyText),
    SCENE_HINT: clean(sceneHint) || 'Not provided',
    IMAGE_PROMPT: clean(imagePrompt) || 'No prompt provided',
    INTERACTIONS_BLOCK: interactionsBlock || '(none declared)',
    ELEMENTS_BLOCK: elementsBlock || '(none)',
    ART_STYLE: evalContext.artStyle || '',
    CLOTHING_CONTRACT: evalContext.clothingContract || '',
    // ONE ROSTER (2026-09-14). buildExpectedCastBlock's block with its kind
    // labels, so an `(animal)` entry is never weighed as a named character.
    // '' for a caller that has no roster — the prompt then judges from the
    // hint alone, exactly as before.
    EXPECTED_CAST: evalContext.expectedCast || '',
    // THE LANDMARK BLOCK (2026-09-18). This judge had none: on a page rendered
    // from a real landmark photo it kept proposing that the real place be
    // replaced, and the one such fix that reached production came from here.
    // Same builder as the other two judges — never a second copy of the wording
    // (landmarkProtection.buildLandmarkContextBlock). '(none)' when the caller
    // supplies no landmark, so no path is left with a hole in the prompt.
    LANDMARK_CONTEXT: evalContext.landmarkContext || '(none)',
    // Same REQUIRED TEXT allow-list the quality and compliance judges get,
    // from the one builder (requiredText.js). '' when the page declares no
    // readable lettering.
    TEXT_RULES: evalContext.textRules || '',
    // The page's `timeOfDay` / `weather` (sceneLight.js) — the same two fields
    // the page prompt's LIGHT line is built from, so the light is judged
    // against what the illustrator was told and never read out of prose.
    // '' when the brief declares none: the check is then skipped.
    DECLARED_LIGHT: declaredLight || '',
    PARENT_COMPARE: buildParentCompareBlock(evalContext.parent || null),
    // ONE rule for every template that authors or judges a page against its
    // text (promptBuilders.TEXT_NOT_A_CHECKLIST_RULE, 2026-09-18). The
    // CHARACTER AUTHORITY paragraph in image-semantic.txt used to state the
    // character half of this in its own words and said nothing about actions;
    // the paragraph now fills from the constant, so the two halves cannot
    // drift from the copies the other eight templates carry.
    TEXT_NOT_A_CHECKLIST: require('./promptBuilders').TEXT_NOT_A_CHECKLIST_RULE,
  });
}

/**
 * The DECLARED LIGHT line the semantic judge is given ("night, clear"; a
 * covered weather adds its sky phrase, "night, fog — fog: …"; '' when
 * the page declares none). The brief carries the fields; the built image
 * prompt does not — and a repaired version's image prompt is the repair
 * instruction. Read the hint first for that reason, the prompt when the hint
 * has no metadata. First renders and repaired versions go through this one
 * derivation (sceneLight.js).
 */
function semanticDeclaredLight(sceneHint, imagePrompt) {
  const { extractSceneMetadata: getSceneMetadata } = require('./storyHelpers');
  const light = require('./sceneLight');
  const fromHint = light.declaredLight(sceneHint ? getSceneMetadata(sceneHint) : null);
  const lit = (fromHint.timeOfDay || fromHint.weather)
    ? fromHint
    : light.declaredLight(getSceneMetadata(imagePrompt || sceneHint || ''));
  // Labels, plus the illustrator's own sky phrase when the weather owns the
  // sky (sceneLight.describeLightForJudge, 2026-09-26).
  return light.describeLightForJudge(lit);
}

/**
 * The semantic judge's DECLARED blocks, read from the page's BRIEF — the
 * source the illustrator's prompt was built from. Pure.
 *
 * DECLARED INTERACTIONS: the brief's `interactions` rows and gazes.
 * PAGE ELEMENTS: the one place a raw id is SHOWN to this judge on purpose. It
 * reads the page's declared objects, resolves each to its bible name, and the
 * judge copies the id back as `element` on every finding about that thing —
 * which is how the repair is later handed the element's picture by id.
 *
 * The brief comes first — the same source order the quality judge reads its
 * declared interactions from (evalPipeline `sceneHint || originalPrompt`). This
 * read `imagePrompt || sceneHint`, and on every pipeline eval imagePrompt is the
 * metadata-stripped prose (stripSceneMetadata), so the judge got
 * "(none declared)" / "(none)" on 80 of 80 stored staging semantic prompts
 * while the brief declared objects on 80 and interactions on 70; and the
 * pipeline passed no bible, so no id could resolve either (2026-09-26,
 * docs/decisions.md "Every critic judges against the source the generator was
 * given, uncut").
 */
function semanticDeclaredBlocks({ sceneHint = null, imagePrompt = null, visualBible = null } = {}) {
  let interactionsBlock = '(none declared)';
  let elementsBlock = '(none)';
  let declaredLightLine = '';
  try {
    const { extractSceneMetadata: getSceneMetadata } = require('./storyHelpers');
    const sceneMeta = getSceneMetadata(sceneHint || imagePrompt || '');
    const interactions = sceneMeta?.interactions
      || (Array.isArray(sceneMeta?.fullData?.interactions) ? sceneMeta.fullData.interactions : null);
    const guard = require('./vbIdGuard');
    interactionsBlock = guard.formatInteractionsBlock(interactions, visualBible, guard.gazeCharacters(sceneMeta));
    const objects = sceneMeta?.objects
      || (Array.isArray(sceneMeta?.fullData?.objects) ? sceneMeta.fullData.objects : null);
    elementsBlock = guard.formatElementsBlock(objects, visualBible);
    declaredLightLine = semanticDeclaredLight(sceneHint, imagePrompt);
  } catch (err) {
    log.error(`[SEMANTIC] declared blocks could not be read from the brief (${err.message}) — the judge gets none`);
  }
  return { interactionsBlock, elementsBlock, declaredLightLine };
}

async function evaluateSemanticFidelity(imageData, storyText, imagePrompt, sceneHint = null, templateOverride = null, evalContext = {}) {
  // evalContext.artStyle / .clothingContract: the same resolved values every
  // other evaluator gets — commissioned style and per-character outfits are
  // spec, not defects, and each judge receives them explicitly.
  if (!storyText || !imageData) {
    log.debug('[SEMANTIC] Skipping semantic evaluation - missing storyText or imageData');
    return null;
  }

  log.verbose('[SEMANTIC] Evaluating semantic fidelity against story text...');

  const { sanitizeForGemini, callGrokVisionAPI, GEMINI_SAFETY_SETTINGS } = require('./images');
  const { TEXT_MODELS } = require('../config/models');
  // The semantic eval emits JSON with per-scene-action checks, visible entities,
  // expected entities, and semantic_issues. No maxOutputTokens (owner rule:
  // no output caps) — Gemini's default is the model's own ceiling.
  const model = genAI.getGenerativeModel({
    model: VISION_MODEL,
    safetySettings: GEMINI_SAFETY_SETTINGS,
    generationConfig: { temperature: EVAL_TEMPERATURE }
  }, EVAL_REQUEST_OPTIONS);
  const startTime = Date.now();

  // Load semantic evaluation template (templateOverride = Test Lab A/B variant)
  const template = templateOverride || PROMPT_TEMPLATES.imageSemantic;
  if (!template) {
    log.warn('[SEMANTIC] Semantic evaluation prompt not loaded, skipping');
    return null;
  }

  // Extract declared interactions. "Before sanitization" used to be literal:
  // STORY_TEXT / SCENE_HINT / IMAGE_PROMPT all go through stripEntityIds below,
  // and this block — which is the ONE place `i.object` (a raw VB id) is
  // rendered — was the exception. Shared builder now (vbIdGuard.js).
  const { interactionsBlock, elementsBlock, declaredLightLine } =
    semanticDeclaredBlocks({ sceneHint, imagePrompt, visualBible: evalContext.visualBible || null });

  // Convert image to base64 if needed
  let imageBase64 = imageData;
  if (imageData.startsWith('data:')) {
    imageBase64 = imageData.split(',')[1];
  }

  // The parent picture of a paired re-judge goes second; nothing is added otherwise.
  const parentData = evalContext.parent?.imageData || null;
  const parentBase64 = parentData ? (parentData.startsWith('data:') ? parentData.split(',')[1] : parentData) : null;
  const parentParts = parentBase64 ? [{ inlineData: { mimeType: 'image/png', data: parentBase64 } }] : [];

  // Build prompt at a given sanitization level
  const buildPrompt = (level) => buildSemanticPrompt(template, {
    storyText, sceneHint, imagePrompt, interactionsBlock, elementsBlock, declaredLight: declaredLightLine, evalContext,
  }, level);

  // Parse the Gemini/Grok response text into a result object
  const parseResponse = (text, usageMeta, elapsed, servedBy) => {
    const usage = { ...pricedUsage(usageMeta, servedBy), elapsed };

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn(`[SEMANTIC] Failed to parse response: ${text.substring(0, 200)}`);
      return { score: null, verdict: 'UNKNOWN', semanticIssues: [], usage, error: 'Failed to parse response' };
    }

    let analysis;
    try {
      analysis = JSON.parse(jsonMatch[0]);
    } catch (err) {
      log.warn(`[SEMANTIC] JSON parse error: ${err.message}`);
      return { score: null, verdict: 'UNKNOWN', semanticIssues: [], usage, error: err.message };
    }

    // analysis.score is deliberately NOT read — image-semantic.txt no longer
    // returns one. The score is computed from semanticIssues below.
    // Unified issue array (2026-08-08). semantic_issues is the pre-unification
    // name and stays readable so stored evaluations keep parsing.
    // PROVENANCE (2026-09-14): every finding names its emitter, in the one
    // field routing reads and scoring passes through (server/lib/findingSources.js).
    const semanticIssues = require('./findingSources').stampFindingSource(
      analysis.fixable_issues || analysis.semantic_issues || [],
      require('./findingSources').FINDING_SOURCES.SEMANTIC
    );
    // PAIRED RE-JUDGE: the judge's own tag, carried as a boolean. Read only when a parent picture
    // was attached; any other call can never mark a finding as shared.
    if (evalContext.parent?.imageData) {
      for (const i of semanticIssues) if (i && i.also_in_parent === true) i.alsoInParent = true;
    }

    log.info(`🔍 [SEMANTIC] Token usage - input: ${usage.input_tokens.toLocaleString()}, output: ${usage.output_tokens.toLocaleString()}, thinking: ${usage.thinking_tokens.toLocaleString()}, cost: $${usage.estimatedCost.toFixed(4)}`);
    if (semanticIssues.length > 0) {
      log.info(`🔍 [SEMANTIC] Found ${semanticIssues.length} semantic issues: ${semanticIssues.map(i => require('./scoring').findingText(i)).join('; ')}`);
    } else {
      log.verbose('[SEMANTIC] No semantic issues found (score: 10/10)');
    }

    // THE SCORE IS THE DEFECTS (owner, 2026-08-08). image-semantic.txt no
    // longer returns a score; it returns semanticIssues[]. Same 0-10 rubric the
    // visual eval uses, so the two subscores stay comparable.
    const SEMANTIC_SEVERITY_PENALTY = { CATASTROPHIC: 5, CRITICAL: 3, MAJOR: 2, MODERATE: 1, MINOR: 0.5 };
    const semanticPenalty = (semanticIssues || []).reduce(
      (sum, i) => sum + (SEMANTIC_SEVERITY_PENALTY[String(i && i.severity).toUpperCase()] ?? 1),
      0
    );
    const semanticScore10 = Math.max(0, Math.min(10, 10 - semanticPenalty));
    return {
      score: semanticScore10 * 10,
      semanticScore10,
      verdict: analysis.verdict || 'UNKNOWN',
      semanticIssues,
      // The judge's answer per parent finding (id, fixed | still_present); null off the paired call.
      parentFindings: evalContext.parent?.imageData && Array.isArray(analysis.parent_findings) ? analysis.parent_findings : null,
      visible: analysis.visible || null,
      expected: analysis.expected || null,
      issues: analysis.issues || [],
      storyActions: analysis.story_actions || [],
      semanticChecks: analysis.semantic_checks || [],
      usage
    };
  };

  // Retry chain: light sanitization → full sanitization → Grok fallback
  const levels = ['light', 'full'];
  for (let i = 0; i < levels.length; i++) {
    const prompt = buildPrompt(levels[i]);
    try {
      const result = await model.generateContent([
        prompt,
        { inlineData: { mimeType: 'image/png', data: imageBase64 } },
        ...parentParts,
      ]);
      const text = result.response.text(); // throws on block
      require('./evalCallLog').recordEvalCall({
        kind: 'semantic', pageNumber: evalContext.pageNumber ?? null, model: VISION_MODEL, prompt, rawResponse: text,
      });
      return parseResponse(text, result.response.usageMetadata, Date.now() - startTime, VISION_MODEL);
    } catch (err) {
      const isBlock = err.message?.includes('PROHIBITED_CONTENT') || err.message?.includes('blocked') || err.message?.includes('SAFETY');
      if (isBlock && i < levels.length - 1) {
        log.warn(`⚠️ [SEMANTIC] Blocked with ${levels[i]} sanitization, retrying with ${levels[i + 1]}...`);
        continue;
      }
      if (isBlock) {
        log.warn(`⚠️ [SEMANTIC] Blocked with full sanitization, falling back to Grok...`);
        break; // fall through to Grok
      }
      // Non-safety error — no retry
      log.error(`[SEMANTIC] Evaluation failed: ${err.message}`);
      return { score: null, verdict: 'ERROR', semanticIssues: [], usage: { tokens: 0, estimatedCost: 0, elapsed: Date.now() - startTime }, error: err.message };
    }
  }

  // Grok vision fallback
  try {
    const grokModelId = GROK_VISION_FALLBACK;
    const grokModel = TEXT_MODELS[grokModelId];
    if (!grokModel || grokModel.provider !== 'xai') {
      log.warn('[SEMANTIC] No Grok model available for fallback');
      return { score: null, verdict: 'ERROR', semanticIssues: [], usage: { tokens: 0, estimatedCost: 0, elapsed: Date.now() - startTime }, error: 'Blocked by Gemini, no Grok fallback' };
    }
    log.info(`🔄 [SEMANTIC] Falling back to Grok vision (${grokModelId})...`);
    const fullPrompt = buildPrompt('full');
    const parts = [
      { inline_data: { mime_type: 'image/png', data: imageBase64 } },
      ...(parentBase64 ? [{ inline_data: { mime_type: 'image/png', data: parentBase64 } }] : []),
      { text: fullPrompt }
    ];
    const grokResponse = await callGrokVisionAPI(grokModelId, grokModel.modelId || grokModelId, parts, fullPrompt);
    if (grokResponse.ok) {
      const grokData = await grokResponse.json();
      const text = grokData?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        log.info('✅ [SEMANTIC] Grok fallback succeeded');
        require('./evalCallLog').recordEvalCall({
          kind: 'semantic', pageNumber: evalContext.pageNumber ?? null, model: grokModelId, prompt: fullPrompt, rawResponse: text,
        });
        return parseResponse(text, grokData.usageMetadata, Date.now() - startTime, grokModelId);
      }
    }
    log.error('[SEMANTIC] Grok fallback returned no text');
    return { score: null, verdict: 'ERROR', semanticIssues: [], usage: { tokens: 0, estimatedCost: 0, elapsed: Date.now() - startTime }, error: 'Grok fallback failed' };
  } catch (grokErr) {
    log.error(`[SEMANTIC] Grok fallback failed: ${grokErr.message}`);
    return { score: null, verdict: 'ERROR', semanticIssues: [], usage: { tokens: 0, estimatedCost: 0, elapsed: Date.now() - startTime }, error: grokErr.message };
  }
}

module.exports = {
  generateCheapPreview,
  describeImage,
  analyzeGeneratedImage,
  formatCharacterContext,
  formatLandmarkContext,
  validateComposition,
  validateScene,
  repairScene,
  validateAndRepairScene,
  isValidationAvailable,
  buildPreviewPrompt,
  generatePreviewFeedback,
  buildSimplePreviewPrompt,
  evaluateSemanticFidelity,
  buildSemanticPrompt,
  buildParentCompareBlock,
  semanticDeclaredLight,
  semanticDeclaredBlocks
};
