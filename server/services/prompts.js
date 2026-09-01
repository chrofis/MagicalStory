/**
 * Prompt Templates Service
 *
 * Loads and manages prompt templates from prompts/ folder
 */

const fs = require('fs').promises;
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { log } = require('../utils/logger');

// The loaded templates. Everything reads them as `PROMPT_TEMPLATES.<key>`.
const TEMPLATE_STORE = {};

// PER-CALL TEMPLATE OVERRIDES (2026-08-25).
//
// The Lab's `promptOverride` used to be implemented by assigning onto this
// registry and restoring in a `finally` — 22 sites doing
// `PROMPT_TEMPLATES.x = override; try { build() } finally { PROMPT_TEMPLATES.x = orig }`.
// That is a global mutation, so only ONE experiment could run at a time: with
// two, B's override is what A's builder reads, or A's restore drops B's
// override while B is still running. The results still look clean — they are
// just attributed to the wrong prompt, which is the worst failure a
// measurement tool can have. It is the reason the Lab was single-flight.
//
// Reads now resolve through an AsyncLocalStorage view, so an override is
// visible only inside the async call tree that set it. Concurrent experiments
// cannot see each other's templates, and no builder had to change: the export
// is a Proxy, so the ~100 `PROMPT_TEMPLATES.key` read sites are untouched.
const templateOverrides = new AsyncLocalStorage();

const PROMPT_TEMPLATES = new Proxy(TEMPLATE_STORE, {
  get(target, key) {
    const overrides = templateOverrides.getStore();
    if (overrides && typeof key === 'string' && Object.prototype.hasOwnProperty.call(overrides, key)) {
      return overrides[key];
    }
    return target[key];
  },
  has(target, key) {
    const overrides = templateOverrides.getStore();
    if (overrides && typeof key === 'string' && Object.prototype.hasOwnProperty.call(overrides, key)) return true;
    return key in target;
  },
  // set / ownKeys / deleteProperty fall through to the target, so load-time
  // population and the derived-template pass (`for (const k of Object.keys(...))`)
  // behave exactly as before.
});

/**
 * Run `fn` with some templates replaced, visible only to this async call tree.
 *
 * @param {Object<string,string>} overrides  template key -> replacement text
 * @param {Function} fn                      sync or async; its result is returned
 * @returns {*} whatever fn returns (a promise if fn is async)
 */
function withTemplates(overrides, fn) {
  const clean = Object.fromEntries(
    Object.entries(overrides || {}).filter(([, v]) => typeof v === 'string' && v.length > 0)
  );
  if (Object.keys(clean).length === 0) return fn();
  // Nested calls merge onto the parent view rather than replacing it, so a
  // stage that overrides two templates in two nested scopes keeps both.
  const parent = templateOverrides.getStore();
  return templateOverrides.run({ ...(parent || {}), ...clean }, fn);
}

// Single source of truth for the character-repair style-match guard. Every
// repair template includes the `{REPAIR_STYLE_GUARD}` token; it is substituted
// with this text at LOAD time (before fillTemplate runs, so it never trips the
// unfilled-placeholder warning). Prevents the guard from drifting across the
// parallel repair templates — the exact bug where the grok_inpaint, grok
// blackout, and gemini repair paths each shipped without it and returned
// photoreal faces in an illustrated scene. Also applied to the LOCAL_PROMPTS
// repair templates read directly in images.js (imported from here).
const REPAIR_STYLE_GUARD = 'Render the repainted area in the same illustration style as the rest of the scene — same line work, shading, and level of detail as the other figures. Do not render it more realistically or more photographically than the surrounding artwork.';

// Single source of truth for the no-lettering guard on REPAIR and EDIT prompts.
// The base page template forbids painted text, but every prompt that repaints
// part of a finished page — the four character-repair variants, the generic
// illustration edit, the inpainting prompt — carried no such rule, so a repair
// pass could add lettering the original render was forbidden to draw. Observed:
// a shipped page acquired an English caption during a repair pass. Same
// load-time token mechanism as the style guard above, for the same reason:
// six parallel templates cannot be kept in sync by hand.
const REPAIR_TEXT_GUARD = 'Add no text of any kind: no caption, watermark, label, signature, or letters, numbers and symbols on any surface in the repainted area. Object names in this prompt say what to draw — never paint a name as lettering. Lettering already present in the untouched part of the image stays exactly as it is.';

/** Substitute the shared repair guards into a template string (load-time). */
function applyRepairStyleGuard(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\{REPAIR_STYLE_GUARD\}/g, REPAIR_STYLE_GUARD)
    .replace(/\{REPAIR_TEXT_GUARD\}/g, REPAIR_TEXT_GUARD);
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
    ['imageInventoryUnified', 'image-inventory-unified.txt'],
    ['imagePromptCompliance', 'image-prompt-compliance.txt'],
    ['imageSemantic', 'image-semantic.txt'],
    // coverImageEvaluation: removed in commit 0f408228 (May 9 2026). The
    // file was deleted but the load-line stayed, which cascaded a load
    // failure across every entry below it. Fall back to imageEvaluation
    // for cover scoring — the two regeneration.js callers already guard
    // with `if (PROMPT_TEMPLATES.coverImageEvaluation)`.
    // Cover-only composition bullets, injected into the SAME image-generation
    // template pages use (buildCoverPrompt). The four cover templates above are
    // retired once every caller routes through it.
    ['coverComposition', 'cover-composition.txt'],
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
    // Post-repair figure-integrity check (repair-acceptance): MATCH/EDGES
    // observations -> enum rating; clearly off or worse rejects the repaint.
    ['repairNaturalness', 'repair-naturalness.txt'],
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
    // LAB ONLY since 2026-09-01: the production beats pipeline no longer runs a
    // reviewer at all (owner ruling — see planCheck below). Two Lab stages still
    // replay it on frozen beats (beats_review_replay, beats_scenes), so the
    // template stays, exactly as arcAuditModel/childCriticModel did when the arc
    // machine replaced that chain. Nothing in production loads it.
    ['storyBeatsReview', 'story-beats-review.txt'],
    // The beats layer's only model check (owner, 2026-09-01). Counts and shot
    // arithmetic run in code (server/lib/planCounters.js); this call answers
    // only the three questions a counter cannot — emotional highlights,
    // entrances, and whether a 3+-cast page's justification holds. It never
    // rewrites a beat; its findings go back to the PLANNER as one re-plan.
    ['planCheck', 'plan-check.txt'],
    // Arc-only review and its judge. The arc is ~15 lines where the beats are a
    // whole book, so a review round costs cents — which is what makes "how many
    // rounds, and with which models" answerable at all.
    ['storyScorecardJudgeV4', 'story-scorecard-judge-v4.txt'],
    ['storyArcReview', 'story-arc-review.txt'],
    // THE ARC MACHINE (2026-08-30): create (two arcs + self-critiques, commit
    // to one), panel (outside models, exactly one solution each), re-tell (the
    // same creator re-tells the story whole — never patches). Replaces the arc
    // audit/review chain in the production beats pipeline; the audit/review
    // templates below stay for the Lab.
    ['arcCreate', 'arc-create.txt'],
    ['arcPanel', 'arc-panel.txt'],
    ['arcRetell', 'arc-retell.txt'],
    ['arcHints', 'arc-hints.txt'],
    ['storyArcJudge', 'story-arc-judge.txt'],
    // Blind audits: each stage's artifact interrogated with ONLY what its
    // audience would have, before the full-context reviewer runs. The audit
    // names faults; the reviewer's fix ledger must answer every one.
    ['storyArcAudit', 'story-arc-audit.txt'],
    ['storyBeatsAudit', 'story-beats-audit.txt'],
    ['storyTextAudit', 'story-text-audit.txt'],
    ['storyTextProofread', 'story-text-proofread.txt'],
    // Final-book audit: the reader's-eye pass. A vision judge receives every
    // page's TEXT followed by that page's SHIPPED IMAGE, in reading order, and
    // routes each fault to the artefact that would fix it (IMG or TEXT).
    ['bookAudit', 'book-audit.txt'],
    // The other half of the arc audit: a listener, not an editor. Runs in
    // parallel with storyArcAudit and its faults join the same review ledger.
    ['storyChildCritic', 'story-child-critic.txt'],
    // Chooses the shipped title from the writer's candidates.
    // One review over ALL scene briefs at once — repetition, visual arc and
    // continuity are only visible across pages, never per-scene.
    ['sceneReview', 'scene-review.txt'],
    // Lab measurement only: counts render hazards per page across a book's
    // briefs (or its beats' SCENE lines). Report-only — nothing consumes it in
    // the pipeline.
    ['sceneHazardAudit', 'scene-hazard-audit.txt'],
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
    // Wardrobe review over the bible's clothing contract (beats-first pipeline,
    // step 3b). It runs BEFORE the styled-avatar kickoff — an outfit reviewed
    // after the avatars exist is a rejected avatar, not a corrected outfit.
    ['clothingReview', 'clothing-review.txt'],
    ['storyTrial', 'story-trial.txt'],
    ['trialIdea', 'trial-idea.txt'],
    // Content rules for a main character aged 3 or under. Injected as
    // {TODDLER_MODE} into the idea, trial and beats prompts, empty otherwise —
    // see buildToddlerModeSection in promptBuilders.js.
    ['toddlerMode', 'toddler-mode.txt'],
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
    ['storyScorecardJudge', 'story-scorecard-judge.txt'],
    ['storyScorecardJudgeV1_1', 'story-scorecard-judge-v1_1.txt'],
    ['storyScorecardJudgeV1_2', 'story-scorecard-judge-v1_2.txt'],
    ['storyScorecardJudgeV2', 'story-scorecard-judge-v2.txt'],
    ['storyScorecardJudgeV3', 'story-scorecard-judge-v3.txt'],
    // Evaluator 4.4: the finished text scored by what a listening child retained.
    ['storyRetellJudge', 'story-retell-judge.txt'],
  ];

  await Promise.all(FILES.map(([k, f]) => load(k, f)));

  // Backwards-compat aliases (computed AFTER loads so the source key is set)
  PROMPT_TEMPLATES.sceneDescriptions = PROMPT_TEMPLATES.sceneIteration;

  // RETIRED 2026-08-26 — the four cover templates and their textless variants.
  // A cover is now built by buildCoverPrompt() from the SAME image-generation
  // template a page uses, plus cover-composition.txt for the title-safe/group
  // bullets. Art is always generated textless; the title, dedication and
  // branding are composited afterwards by coverTypography.js — the one extra
  // pass a cover gets over a page.

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
 * @param {Object} [opts.visualBible]      - Visual Bible, used to resolve VB ids
 *   (ART008 → "carved stone trail marker") before the prompt reaches the model.
 *   ALWAYS pass it — see the sanitizer note in the body.
 * @param {number} [opts.pageNumber]       - Page number, for sanitizer logging
 * @param {'landmark'|'element'} [opts.referenceKind] - Which single reference family
 *   is attached to this plate call (landmark photo XOR Visual Bible element render).
 *   Adds the REFERENCE line telling the model to render the visible PART of it.
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
  // Append the Visual Bible description of every vehicle listed for this page.
  // The Art Director's plate prose routinely names a vessel generically ("a
  // boat sits tied at the quay") and the plate model invents its own — a
  // shipped story rendered the crew's single-mast sailing boat as a mastless
  // rowboat because the background plate drew one and the placement pass keeps
  // the plate's pixels. Conditional wording so a plate whose framing shows no
  // vehicle doesn't gain one.
  if (opts.visualBible && opts.pageNumber != null) {
    const pageVehicles = (opts.visualBible.vehicles || []).filter(v => {
      const pages = v.pages || v.appearsInPages;
      return Array.isArray(pages) && pages.includes(opts.pageNumber) && v.description;
    });
    if (pageVehicles.length > 0) {
      const lines = pageVehicles.map(v => `- ${v.name || v.type || 'vehicle'}: ${v.description}`);
      // Render only the visible PART, not the whole vessel. The old wording
      // ("render it exactly to its description") demanded the full vehicle even
      // when the camera stands on its deck, which shipped duplicate ships, a
      // ship inside a cave, and wheels on dry land (audit 2026-08-29).
      description += `\n\n**VEHICLES:** Any boat, ship, wagon, carriage, or other vehicle in this backdrop is one of the vessels described below — match its colour, construction and named parts, never a generic substitute:\n${lines.join('\n')}\nRender only the part of the vessel the camera sees. When the camera stands on board, show the deck, rail and fittings around it — never the vessel seen from outside.`;
    }
  }

  // The plate call carries exactly ONE family of visual reference: a landmark
  // photo when the location is real, otherwise the Visual Bible element
  // render(s) — never both (owner, 2026-08-29; enforced in
  // buildEmptySceneVbGrid). This line tells the model what the attached
  // reference IS, and that it renders the visible part rather than the whole
  // object. Same wording for both families.
  if (opts.referenceKind === 'landmark' || opts.referenceKind === 'element') {
    description += `\n\n**REFERENCE:** The place or vessel in this scene is the one shown in the attached reference image — render the part of it the camera sees, consistent in colour and construction.`;
  }

  const filled = fillTemplate(opts.template || PROMPT_TEMPLATES.emptyScene, {
    STYLE_DESCRIPTION: opts.style || '',
    EMPTY_SCENE_DESCRIPTION: description,
    CHARACTER_SPACE: opts.characterSpace || '',
    TEXT_AREA_INSTRUCTION: opts.textAreaInstruction || '',
    ERA_GUARD: opts.eraGuard || '',
    LANDMARK_FIDELITY: opts.landmarkFidelity || '',
  });

  // Resolve VB ids to their English refs before the model sees them. The
  // description is assembled from Visual Bible prose, and the writer routinely
  // embeds ids in it ("the carved stone marker ART008 sits at the fork"), so
  // an unsanitized empty-scene prompt gets the token PAINTED onto the object —
  // observed on a shipped story: "ART008" lettered twice on a trail stone,
  // "ART007" on a chest, the VB entity name on a signpost. The empty scene is
  // the style/layout anchor the populated page is rendered from, so whatever
  // it paints carries into the final image.
  //
  // Sanitizing here rather than at each call site: this builder is the single
  // gate every empty-scene prompt passes through (page, vantage plate, cover
  // plate, QC retry, iterate, Test Lab). Lazy require — promptBuilders.js
  // requires this module at load, so a top-level import would close a cycle.
  if (!opts.visualBible) return filled;
  const { sanitizeVbIdsInPrompt } = require('../lib/promptBuilders');
  return sanitizeVbIdsInPrompt(filled, opts.visualBible, opts.pageNumber ?? null);
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
    // Empty when the caller has no prompt to read a style from — the template
    // then tells the model to skip the style rule and judge normally.
    ART_STYLE: opts.artStyle || extractArtStyle(opts.originalPrompt) || '',
  });
}

module.exports = {
  PROMPT_TEMPLATES,
  withTemplates,
  loadPromptTemplates,
  fillTemplate,
  buildEmptyScenePrompt,
  buildEvaluationPrompt,
  extractArtStyle,
  resolveEvalArtStyle,
  REPAIR_STYLE_GUARD,
  applyRepairStyleGuard,
};
