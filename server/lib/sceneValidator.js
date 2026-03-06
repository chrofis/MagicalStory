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
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { log } = require('../utils/logger');
const { expandPositionAbbreviations } = require('./storyHelpers');
const { getPhysical } = require('./characterPhysical');

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const VISION_MODEL = 'gemini-2.5-flash';
const COMPARISON_MODEL = 'gemini-2.5-flash';

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

  const model = genAI.getGenerativeModel({ model: VISION_MODEL });
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

  const usage = result.response.usageMetadata;
  const tokens = (usage?.promptTokenCount || 0) + (usage?.candidatesTokenCount || 0);
  // Gemini 2.5 Flash pricing
  const estimatedCost = ((usage?.promptTokenCount || 0) * 0.15 + (usage?.candidatesTokenCount || 0) * 0.60) / 1000000;

  log.debug(`[SCENE-VALIDATOR] Description complete in ${elapsed}ms, tokens: ${tokens}`);

  return {
    description: text,
    usage: { tokens, estimatedCost, elapsed }
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
    const clothing = clothingRequirements[char.name]?._currentClothing || 'standard';
    const clothingDesc = char.avatars?.clothing?.[clothing] || 'unknown clothing';
    const physical = getPhysical(char);

    const traits = [];
    if (physical.hairColor) traits.push(`${physical.hairColor} hair`);
    if (physical.hairStyle) traits.push(`(${physical.hairStyle})`);
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
      items.push(`- ${animal.name || id}: ${animal.description || 'animal'}`);
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

  const model = genAI.getGenerativeModel({ model: VISION_MODEL });
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

  const usage = result.response.usageMetadata;
  const tokens = (usage?.promptTokenCount || 0) + (usage?.candidatesTokenCount || 0);
  // Gemini 2.5 Flash pricing
  const estimatedCost = ((usage?.promptTokenCount || 0) * 0.15 + (usage?.candidatesTokenCount || 0) * 0.60) / 1000000;

  log.debug(`[SCENE-VALIDATOR] Generated image analysis complete in ${elapsed}ms, tokens: ${tokens}`);

  return {
    description: text,
    usage: { tokens, estimatedCost, elapsed }
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

  const model = genAI.getGenerativeModel({ model: COMPARISON_MODEL });
  const startTime = Date.now();

  // Format scene JSON for the prompt
  const sceneJsonStr = typeof sceneJson === 'string' ? sceneJson : JSON.stringify(sceneJson, null, 2);

  const fullPrompt = COMPARISON_PROMPT
    .replace('{SCENE_JSON}', sceneJsonStr)
    .replace('{IMAGE_DESCRIPTION}', imageDescription);

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

  const usage = result.response.usageMetadata;
  const tokens = (usage?.promptTokenCount || 0) + (usage?.candidatesTokenCount || 0);
  const estimatedCost = ((usage?.promptTokenCount || 0) * 0.15 + (usage?.candidatesTokenCount || 0) * 0.60) / 1000000;

  log.debug(`[SCENE-VALIDATOR] Comparison complete in ${elapsed}ms, tokens: ${tokens}`);

  return {
    checks: analysis.checks || [],
    compositionIssues: analysis.compositionIssues || [],
    passesCompositionCheck: analysis.passesCompositionCheck !== false,
    summary: analysis.summary || '',
    usage: { tokens, estimatedCost, elapsed }
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
    visionTokens: imageDesc.usage.tokens,
    visionCost: imageDesc.usage.estimatedCost,
    comparisonTokens: comparison.usage.tokens,
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
  const result = await callTextModel(repairPrompt, 4000, null, { prefill: '{' });

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
async function evaluateSemanticFidelity(imageData, storyText, imagePrompt, sceneHint = null) {
  if (!storyText || !imageData) {
    log.debug('[SEMANTIC] Skipping semantic evaluation - missing storyText or imageData');
    return null;
  }

  log.debug('[SEMANTIC] Evaluating semantic fidelity against story text...');

  const model = genAI.getGenerativeModel({ model: VISION_MODEL });
  const startTime = Date.now();

  // Load semantic evaluation template
  const template = PROMPT_TEMPLATES.imageSemantic;
  if (!template) {
    log.warn('[SEMANTIC] Semantic evaluation prompt not loaded, skipping');
    return null;
  }

  const prompt = fillTemplate(template, {
    STORY_TEXT: storyText,
    SCENE_HINT: sceneHint || 'Not provided',
    IMAGE_PROMPT: imagePrompt || 'No prompt provided'
  });

  // Convert image to base64 if needed
  let imageBase64 = imageData;
  if (imageData.startsWith('data:')) {
    imageBase64 = imageData.split(',')[1];
  }

  try {
    const result = await model.generateContent([
      prompt,
      { inlineData: { mimeType: 'image/png', data: imageBase64 } }
    ]);

    const elapsed = Date.now() - startTime;
    const text = result.response.text();

    const usage = result.response.usageMetadata;
    const tokens = (usage?.promptTokenCount || 0) + (usage?.candidatesTokenCount || 0);
    const estimatedCost = ((usage?.promptTokenCount || 0) * 0.15 + (usage?.candidatesTokenCount || 0) * 0.60) / 1000000;

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn(`[SEMANTIC] Failed to parse response: ${text.substring(0, 200)}`);
      return {
        score: null,
        verdict: 'UNKNOWN',
        semanticIssues: [],
        usage: { tokens, estimatedCost, elapsed },
        error: 'Failed to parse response'
      };
    }

    let analysis;
    try {
      analysis = JSON.parse(jsonMatch[0]);
    } catch (err) {
      log.warn(`[SEMANTIC] JSON parse error: ${err.message}`);
      return {
        score: null,
        verdict: 'UNKNOWN',
        semanticIssues: [],
        usage: { tokens, estimatedCost, elapsed },
        error: err.message
      };
    }

    const score = analysis.score ?? null;
    const verdict = analysis.verdict || 'UNKNOWN';
    const semanticIssues = analysis.semantic_issues || [];

    // Log token usage
    log.info(`🔍 [SEMANTIC] Token usage - input: ${usage?.promptTokenCount?.toLocaleString() || 0}, output: ${usage?.candidatesTokenCount?.toLocaleString() || 0}, cost: $${estimatedCost.toFixed(4)}`);

    if (semanticIssues.length > 0) {
      log.info(`🔍 [SEMANTIC] Found ${semanticIssues.length} semantic issues: ${semanticIssues.map(i => i.problem).join('; ')}`);
    } else {
      log.debug(`[SEMANTIC] No semantic issues found (score: ${score}/10)`);
    }

    return {
      score: score !== null ? score * 10 : null, // Convert 0-10 to 0-100
      rawScore: score,
      verdict,
      semanticIssues,
      // Full analysis for UI display
      visible: analysis.visible || null,
      expected: analysis.expected || null,
      issues: analysis.issues || [],
      // Legacy fields (old prompt format)
      storyActions: analysis.story_actions || [],
      semanticChecks: analysis.semantic_checks || [],
      usage: {
        tokens,
        input_tokens: usage?.promptTokenCount || 0,
        output_tokens: usage?.candidatesTokenCount || 0,
        estimatedCost,
        elapsed
      }
    };
  } catch (err) {
    log.error(`[SEMANTIC] Evaluation failed: ${err.message}`);
    return {
      score: null,
      verdict: 'ERROR',
      semanticIssues: [],
      usage: { tokens: 0, estimatedCost: 0, elapsed: Date.now() - startTime },
      error: err.message
    };
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
  evaluateSemanticFidelity
};
