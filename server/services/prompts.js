/**
 * Prompt Templates Service
 *
 * Loads and manages prompt templates from prompts/ folder
 */

const fs = require('fs').promises;
const path = require('path');
const { log } = require('../utils/logger');

const PROMPT_TEMPLATES = {};

async function loadPromptTemplates() {
  const promptsDir = path.join(__dirname, '../../prompts');
  // Per-key load wrapper. If one file is missing, log the specific failure
  // and CONTINUE. The previous giant try/catch aborted the whole load on
  // the first ENOENT, leaving every subsequent key undefined (including
  // avatarSystemInstruction + avatarMainPrompt). At request time this
  // produced silent 400s from Gemini ("system_instruction.parts[0].data:
  // required oneof field 'data' must have one initialized field") because
  // the avatar code happily sends `text: undefined` → JSON drops it →
  // Gemini sees an empty Part. Per-key loading + a clear failure summary
  // makes one missing file visible without blocking everything else.
  const failures = [];
  const load = async (key, filename) => {
    try {
      PROMPT_TEMPLATES[key] = await fs.readFile(path.join(promptsDir, filename), 'utf-8');
    } catch (err) {
      failures.push({ key, filename, message: err.message });
    }
  };

  // Each line: [key, filename]. Order doesn't matter — failures are isolated.
  const FILES = [
    ['outline', 'outline.txt'],
    ['storyText', 'story-text.txt'],
    ['sceneExpansion', 'scene-expansion.txt'],
    ['sceneIteration', 'scene-iteration.txt'],
    ['sceneIterationFree', 'scene-iteration-free.txt'],
    ['imageGeneration', 'image-generation.txt'],
    ['imageEvaluation', 'image-evaluation.txt'],
    ['imageVisualInventory', 'image-visual-inventory.txt'],
    ['imageVisionInventory', 'image-vision-inventory.txt'],
    ['imagePromptCompliance', 'image-prompt-compliance.txt'],
    ['imageSemantic', 'image-semantic.txt'],
    // coverImageEvaluation: removed in commit 0f408228 (May 9 2026). The
    // file was deleted but the load-line stayed, which cascaded a load
    // failure across every entry below it. Fall back to imageEvaluation
    // for cover scoring — the two regeneration.js callers already guard
    // with `if (PROMPT_TEMPLATES.coverImageEvaluation)`.
    ['frontCover', 'front-cover.txt'],
    ['initialPageWithDedication', 'initial-page-with-dedication.txt'],
    ['initialPageNoDedication', 'initial-page-no-dedication.txt'],
    ['backCover', 'back-cover.txt'],
    ['storybookCombined', 'storybook-combined.txt'],
    ['rewriteBlockedScene', 'rewrite-blocked-scene.txt'],
    ['characterAnalysis', 'character-analysis.txt'],
    ['imageSystemInstruction', 'image-system-instruction.txt'],
    ['avatarSystemInstruction', 'avatar-system-instruction.txt'],
    ['avatarMainPrompt', 'avatar-main-prompt.txt'],
    ['avatarAcePrompt', 'avatar-ace-prompt.txt'],
    ['avatarRetryPrompt', 'avatar-retry-prompt.txt'],
    ['avatarEvaluation', 'avatar-evaluation.txt'],
    ['sheet2x4Evaluation', 'sheet-2x4-evaluation.txt'],
    ['sheet2x4StyleEval', 'sheet-2x4-style-eval.txt'],
    ['styledCostumedAvatar', 'styled-costumed-avatar.txt'],
    ['visualBibleAnalysis', 'visual-bible-analysis.txt'],
    ['illustrationEdit', 'illustration-edit.txt'],
    ['imageInspection', 'image-inspection.txt'],
    ['inpainting', 'inpainting.txt'],
    ['characterRepairBlended', 'character-repair-blended.txt'],
    ['characterRepairBodyBlended', 'character-repair-body-blended.txt'],
    ['characterRepairCutout', 'character-repair-cutout.txt'],
    ['characterRepairInpaint', 'character-repair-inpaint.txt'],
    ['bboxRefine', 'bbox-refine.txt'],
    ['storyUnified', 'story-unified.txt'],
    ['storyTrial', 'story-trial.txt'],
    ['trialIdea', 'trial-idea.txt'],
    ['finalConsistencyCheck', 'final-consistency-check.txt'],
    ['textConsistencyCheck', 'text-consistency-check.txt'],
    ['incrementalConsistencyCheck', 'incremental-consistency-check.txt'],
    ['boundingBoxDetection', 'bounding-box-detection.txt'],
    ['repairVerification', 'repair-verification.txt'],
    ['referenceSheet', 'reference-sheet.txt'],
    ['sceneRepair', 'scene-repair.txt'],
    ['entityConsistencyCheck', 'entity-consistency-check.txt'],
    ['entitySinglePageRepair', 'entity-single-page-repair.txt'],
    ['subRegionDetection', 'sub-region-detection.txt'],
    ['generatedImageAnalysis', 'generated-image-analysis.txt'],
    ['emptyScene', 'empty-scene.txt'],
    ['textSpaceRepair', 'text-space-repair.txt'],
    ['feedbackConsolidator', 'feedback-consolidator.txt'],
  ];

  await Promise.all(FILES.map(([k, f]) => load(k, f)));

  // Backwards-compat aliases (computed AFTER loads so the source key is set)
  PROMPT_TEMPLATES.sceneDescriptions = PROMPT_TEMPLATES.sceneIteration;

  if (failures.length > 0) {
    log.error(`❌ Prompt template load: ${failures.length} file(s) failed:`);
    for (const f of failures) {
      log.error(`   - ${f.key} (${f.filename}): ${f.message}`);
    }
  }
  log.info(`📝 Prompt templates loaded: ${FILES.length - failures.length}/${FILES.length} ok`);
}

/**
 * Replace placeholders in prompt templates
 * @param {string} template - Template string with {PLACEHOLDER} syntax
 * @param {Object} replacements - Key-value pairs for replacements
 * @returns {string} Filled template
 */
function fillTemplate(template, replacements) {
  if (!template) return '';
  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Treat undefined/null as empty — without this, missing keys leave literal
    // `{KEY}` placeholders in the output, which get shipped to image models.
    const safeValue = String(value ?? '').replace(/\$/g, '$$$$');
    result = result.replace(new RegExp(`\\{${escapedKey}\\}`, 'g'), safeValue);
  }
  // Warn (then strip) any placeholders the caller didn't provide. The strip
  // alone hides typos and missing fills — a misspelled key vanishes silently
  // and the prompt ships with a hole. Logging the unfilled tokens makes those
  // bugs visible without changing behaviour.
  const unfilled = result.match(/\{[A-Z][A-Z0-9_]*\}/g);
  if (unfilled && unfilled.length > 0) {
    const unique = [...new Set(unfilled)];
    log.warn(`[PROMPT] Unfilled placeholder(s) stripped: ${unique.join(', ')}`);
  }
  result = result.replace(/\{[A-Z][A-Z0-9_]*\}/g, '');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

/**
 * Build the empty-scene generation prompt from a known opts contract.
 *
 * The empty-scene template (prompts/empty-scene.txt) has six placeholders:
 *   STYLE_DESCRIPTION, EMPTY_SCENE_DESCRIPTION, CHARACTER_SPACE,
 *   REQUIRED_OBJECTS, TEXT_AREA_INSTRUCTION, ERA_GUARD, LANDMARK_FIDELITY.
 *
 * Before this helper, every empty-scene call site (server.js × 3,
 * coverIterate.js, images.js × 1) hand-built the replacements bag and
 * inconsistently forgot LANDMARK_FIDELITY — fillTemplate then stripped the
 * placeholder + emitted a per-call WARN. This single chokepoint enforces
 * the placeholder contract: every key is filled (with '' as the safe
 * default), so the template emerges hole-free regardless of which caller
 * built it.
 *
 * New empty-scene call sites just call this helper and pass what they
 * have — never raw fillTemplate on PROMPT_TEMPLATES.emptyScene.
 *
 * @param {Object} opts
 * @param {string} opts.style              - Resolved style description (paragraph form)
 * @param {string} opts.description        - Empty-scene description body
 * @param {string} [opts.characterSpace]   - Optional character-space instruction
 * @param {string} [opts.requiredObjects]  - Optional required-objects block
 * @param {string} [opts.textAreaInstruction] - Optional text-zone instruction
 * @param {string} [opts.eraGuard]         - Optional era-guard guidance
 * @param {string} [opts.landmarkFidelity] - Optional landmark-fidelity block
 * @returns {string} Filled prompt ready for the image model.
 */
function buildEmptyScenePrompt(opts = {}) {
  if (!PROMPT_TEMPLATES.emptyScene) {
    throw new Error('buildEmptyScenePrompt: empty-scene template not loaded');
  }
  return fillTemplate(PROMPT_TEMPLATES.emptyScene, {
    STYLE_DESCRIPTION: opts.style || '',
    EMPTY_SCENE_DESCRIPTION: opts.description || '',
    CHARACTER_SPACE: opts.characterSpace || '',
    REQUIRED_OBJECTS: opts.requiredObjects || '',
    TEXT_AREA_INSTRUCTION: opts.textAreaInstruction || '',
    ERA_GUARD: opts.eraGuard || '',
    LANDMARK_FIDELITY: opts.landmarkFidelity || '',
  });
}

/**
 * Build the image-evaluation prompt from a known opts contract.
 *
 * The image-evaluation template (prompts/image-evaluation.txt) has four
 * placeholders: ORIGINAL_PROMPT, INTERACTIONS_BLOCK, SCENE_INTENT,
 * FIGURE_PROPORTIONS.
 *
 * Before this helper, images.js:1346 filled all four correctly while
 * regeneration.js:3844 (the admin re-evaluate endpoint) passed only
 * ORIGINAL_PROMPT — Gemini then got a prompt with 3 stripped placeholders
 * and ran with degraded context. This helper enforces the contract so
 * every call site can't accidentally omit a key.
 *
 * @param {Object} opts
 * @param {string} opts.originalPrompt       - The original image prompt
 * @param {string} [opts.interactionsBlock]  - Declared-interactions block
 * @param {string} [opts.sceneIntent]        - Scene intent line
 * @param {string} [opts.figureProportions]  - Figure-proportions block
 * @returns {string} Filled prompt ready for Gemini eval.
 */
function buildEvaluationPrompt(opts = {}) {
  if (!PROMPT_TEMPLATES.imageEvaluation) {
    throw new Error('buildEvaluationPrompt: imageEvaluation template not loaded');
  }
  return fillTemplate(PROMPT_TEMPLATES.imageEvaluation, {
    ORIGINAL_PROMPT: opts.originalPrompt || '',
    INTERACTIONS_BLOCK: opts.interactionsBlock || '',
    SCENE_INTENT: opts.sceneIntent || '',
    FIGURE_PROPORTIONS: opts.figureProportions || '',
  });
}

module.exports = {
  PROMPT_TEMPLATES,
  loadPromptTemplates,
  fillTemplate,
  buildEmptyScenePrompt,
  buildEvaluationPrompt,
};
