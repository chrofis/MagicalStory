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
    // ALL-pages scene expansion (beats pipeline). One call writes every page's
    // brief with the others in view, so location, time of day, clothing and
    // composition cannot drift between neighbours. scene-expansion.txt stays
    // the per-page variant used by the unified pipeline's fallback.
    ['sceneExpansionAll', 'scene-expansion-all.txt'],
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
    ['sheetRowHeadsEval', 'sheet-row-heads-eval.txt'],
    ['sheetRowBodiesEval', 'sheet-row-bodies-eval.txt'],
    ['sheetRowIdentityEval', 'sheet-row-identity-eval.txt'],
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
    ['storyUnifiedImageFirst', 'story-unified-imagefirst.txt'],
    // Shared ANALYSIS instruction bodies — injected into the {ANALYSIS_INSTRUCTIONS}
    // placeholder of the matching unified template (single-call mode) AND into the
    // external reviewer prompt (split outline review). One source per variant so the
    // self-critique and the external review can never drift apart.
    ['outlineAnalysisTextFirst', 'outline-analysis-textfirst.txt'],
    ['outlineAnalysisImageFirst', 'outline-analysis-imagefirst.txt'],
    ['outlineReview', 'outline-review.txt'],
    // Iterative text refinement (Lab): full text in, full text out, one round
    // feeding the next. Scene outlines are read-only context so the prose stays
    // consistent with illustrations that already exist.
    ['textRefine', 'text-refine.txt'],
    // Beats-first planning (Lab): page beats + one-line scene intents, then a
    // fast structural review — the cheapest point to fix an arc, and the gate
    // that locks scenes so image generation can start.
    ['storyBeats', 'story-beats.txt'],
    ['storyBeatsReview', 'story-beats-review.txt'],
    // One review over ALL scene briefs at once — repetition, visual arc and
    // continuity are only visible across pages, never per-scene.
    ['sceneReview', 'scene-review.txt'],
    // Page text written from the locked beats (beats-first pipeline, step 5).
    // Same ---ANALYSIS--- / ---STORY TEXT--- shape as the refiner, so
    // parseRefinedText reads it unchanged.
    ['storyTextFromBeats', 'story-text-from-beats.txt'],
    // Visual contract from the locked beats (beats-first pipeline, step 3 —
    // it runs BEFORE scene expansion, which consumes its Visual Bible). Emits
    // ---CLOTHING REQUIREMENTS--- / ---VISUAL BIBLE--- / ---COVER SCENE
    // HINTS--- in the unified section format, so UnifiedStoryParser reads a
    // beats transcript with no parser change.
    ['storyBibleFromBeats', 'story-bible-from-beats.txt'],
    ['storyTrial', 'story-trial.txt'],
    ['trialIdea', 'trial-idea.txt'],
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
    ['storyTextQualityJudge', 'story-text-quality-judge.txt'],
  ];

  await Promise.all(FILES.map(([k, f]) => load(k, f)));

  // Backwards-compat aliases (computed AFTER loads so the source key is set)
  PROMPT_TEMPLATES.sceneDescriptions = PROMPT_TEMPLATES.sceneIteration;

  // Textless cover variants (for app-side cover typography — MODEL_DEFAULTS.appSideCoverType).
  // Derived from the base templates so composition edits auto-sync: the labelled text-baking block
  // (**TITLE:** / **TEXT:**) is replaced with an explicit no-text directive. The initial page just
  // uses the existing initialPageNoDedication when the flag is on. Kept off the two paint paths.
  // Owner rule (tasks/lessons.md): state the constraint ONLY — never why ("text added afterwards")
  // and never "empty/uncluttered space"; both invited painted titles and blank white bands.
  const NO_TEXT = '**NO TEXT:**\nThe illustration contains no written text of any kind — no title, no lettering, no caption, no letters, numbers, or symbols anywhere in the image.\n';
  // Lookahead stops at the next **SECTION**, the next {PLACEHOLDER} line, or
  // end-of-template — the text-baking block is the LAST section in the cover
  // templates (followed only by {VISUAL_BIBLE}) since the duplicate FRAMING
  // section was merged into the opening paragraph.
  const makeTextless = (tpl, label) => tpl ? tpl.replace(new RegExp(`\\*\\*${label}:\\*\\*[\\s\\S]*?(?=\\n\\*\\*|\\n\\{|$)`), NO_TEXT) : tpl;
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
 * Pull the ART STYLE block out of a built image prompt.
 *
 * The evaluators must judge style elements against the style THIS book was
 * commissioned in — neon signage is required in a cyberpunk story and a defect
 * in a watercolour one — so the rule cannot be a fixed list baked into the
 * evaluator template. It is passed per call instead.
 *
 * Extraction rather than a new threaded parameter because every eval call site
 * already has the built page prompt, and the compliance evaluator truncates
 * ORIGINAL_PROMPT to 3000 chars — the ART STYLE block sits at the END of a
 * ~7000-char page prompt, so it was being cut off before the model ever saw it.
 *
 * @param {string} imagePrompt - a built page/cover prompt
 * @returns {string} the style text, or '' when the prompt has no style block
 */
function extractArtStyle(imagePrompt) {
  if (!imagePrompt || typeof imagePrompt !== 'string') return '';
  const m = imagePrompt.match(/\*\*ART STYLE:\*\*\s*([\s\S]*?)(?:\n\s*\n|$)/i);
  return m ? m[1].trim() : '';
}

/**
 * The ONE way an evaluator learns which medium a page was commissioned in.
 *
 * Both the production repair-round eval and the Test Lab quality_eval stage call
 * this, so the Lab cannot silently diverge from staging. It previously did: the
 * pipeline passed the scene DESCRIPTION as ORIGINAL_PROMPT and the Lab passed a
 * different string, and neither carried the ART STYLE block, so every
 * style-dependent rule skipped without a trace.
 *
 * Prefers the style KEY (authoritative, the same value the generator used) and
 * falls back to parsing a built page prompt. Returns an empty string when
 * neither is available, which the templates treat as "skip the style rule".
 *
 * @param {string|null} artStyleKey  e.g. 'cyber' - from storyData.artStyle
 * @param {string|null} [pagePrompt] a built page prompt, used only as fallback
 */
function resolveEvalArtStyle(artStyleKey, pagePrompt = null) {
  if (artStyleKey) {
    try {
      const { resolveArtStyle } = require('../lib/storyHelpers');
      const desc = resolveArtStyle(artStyleKey);
      if (desc) return desc;
    } catch { /* storyHelpers unavailable - fall through to the prompt */ }
  }
  return extractArtStyle(pagePrompt || '');
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
    // Empty when the caller could not resolve the per-page outfit — the
    // template then tells the model to skip clothing judgments entirely
    // rather than invent a contract from the theme.
    CLOTHING_CONTRACT: opts.clothingContract || '',
    FIGURE_PROPORTIONS: opts.figureProportions || '',
    // Empty when the caller has no prompt to read a style from — the template
    // then tells the model to skip the style rule and judge normally.
    ART_STYLE: opts.artStyle || extractArtStyle(opts.originalPrompt) || '',
  });
}

module.exports = {
  PROMPT_TEMPLATES,
  loadPromptTemplates,
  fillTemplate,
  buildEmptyScenePrompt,
  buildEvaluationPrompt,
  extractArtStyle,
  resolveEvalArtStyle,
  REPAIR_STYLE_GUARD,
  applyRepairStyleGuard,
};
