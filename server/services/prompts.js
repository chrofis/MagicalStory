/**
 * Prompt Templates Service
 *
 * Loads and manages prompt templates from prompts/ folder
 */

const fs = require('fs').promises;
const path = require('path');
const { log } = require('../utils/logger');

const PROMPT_TEMPLATES = {};

// Single source of truth for the character-repair style-match guard. Every
// repair template includes the `{REPAIR_STYLE_GUARD}` token; it is substituted
// with this text at LOAD time (before fillTemplate runs, so it never trips the
// unfilled-placeholder warning). Prevents the guard from drifting across the
// parallel repair templates — the exact bug where the grok_inpaint, grok
// blackout, and gemini repair paths each shipped without it and returned
// photoreal faces in an illustrated scene. Also applied to the LOCAL_PROMPTS
// repair templates read directly in images.js (imported from here).
const REPAIR_STYLE_GUARD = 'Render the repainted area in the same illustration style as the rest of the scene — same line work, shading, and level of detail as the other figures. Do not render it more realistically or more photographically than the surrounding artwork.';

/** Substitute the shared repair guard into a template string (load-time). */
function applyRepairStyleGuard(text) {
  return typeof text === 'string' ? text.replace(/\{REPAIR_STYLE_GUARD\}/g, REPAIR_STYLE_GUARD) : text;
}

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

  // Textless cover variants (for app-side cover typography — MODEL_DEFAULTS.appSideCoverType).
  // Derived from the base templates so composition edits auto-sync: the labelled text-baking block
  // (**TITLE:** / **TEXT:**) is replaced with an explicit no-text directive. The initial page just
  // uses the existing initialPageNoDedication when the flag is on. Kept off the two paint paths.
  const NO_TEXT = '**NO TEXT:**\nLeave the illustration completely free of any title, caption, letters, numbers, or written text — the text is added afterwards. Keep the composition clean with calm, uncluttered space.\n';
  const makeTextless = (tpl, label) => tpl ? tpl.replace(new RegExp(`\\*\\*${label}:\\*\\*[\\s\\S]*?(?=\\n\\*\\*)`), NO_TEXT) : tpl;
  PROMPT_TEMPLATES.frontCoverTextless = makeTextless(PROMPT_TEMPLATES.frontCover, 'TITLE');
  PROMPT_TEMPLATES.backCoverTextless = makeTextless(PROMPT_TEMPLATES.backCover, 'TEXT');

  // One-source-of-truth repair guard: fill {REPAIR_STYLE_GUARD} in every
  // template that carries it (all character-repair templates).
  for (const k of Object.keys(PROMPT_TEMPLATES)) {
    PROMPT_TEMPLATES[k] = applyRepairStyleGuard(PROMPT_TEMPLATES[k]);
  }

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
 *   TEXT_AREA_INSTRUCTION, ERA_GUARD, LANDMARK_FIDELITY.
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
 * @param {string} [opts.textAreaInstruction] - Optional text-zone instruction
 * @param {string} [opts.eraGuard]         - Optional era-guard guidance
 * @param {string} [opts.landmarkFidelity] - Optional landmark-fidelity block
 * @returns {string} Filled prompt ready for the image model.
 */
function buildEmptyScenePrompt(opts = {}) {
  // opts.template: Test Lab A/B override — a full replacement template string
  // used instead of the loaded file (never mutates PROMPT_TEMPLATES).
  if (!opts.template && !PROMPT_TEMPLATES.emptyScene) {
    throw new Error('buildEmptyScenePrompt: empty-scene template not loaded');
  }
  // The template's framing rule says "Use the camera angle named in the
  // **SHOT** line above" — the vantage path includes one in its description,
  // but the cover-plate and trial paths don't. Prepend a default so the
  // reference never dangles.
  let description = opts.description || '';
  if (!/\*\*SHOT:\*\*|\*\*CAMERA:\*\*/i.test(description)) {
    description = `**SHOT:** wide\n\n${description}`;
  }
  return fillTemplate(opts.template || PROMPT_TEMPLATES.emptyScene, {
    STYLE_DESCRIPTION: opts.style || '',
    EMPTY_SCENE_DESCRIPTION: description,
    CHARACTER_SPACE: opts.characterSpace || '',
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
  // opts.template: Test Lab A/B override — a full replacement template string
  // used instead of the loaded file (never mutates PROMPT_TEMPLATES).
  if (!opts.template && !PROMPT_TEMPLATES.imageEvaluation) {
    throw new Error('buildEvaluationPrompt: imageEvaluation template not loaded');
  }
  return fillTemplate(opts.template || PROMPT_TEMPLATES.imageEvaluation, {
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
  REPAIR_STYLE_GUARD,
  applyRepairStyleGuard,
};
