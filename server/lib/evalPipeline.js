/**
 * Image Evaluation Pipeline
 *
 * Extracted verbatim from server/lib/images.js (lines 571-2434 at commit
 * be1da6068) as phase 4 of the god-file split. images.js re-exports every
 * public name here (facade), so all existing imports keep working.
 *
 * Contents: runVisualInventory (P1 prompt-blind inventory), validateEmptyScene
 * (text-zone QC), capComplianceIdentitySeverity, evaluateThreeStage,
 * sanitizeForGemini, isBlockedResponse (private), evaluateImageQuality (core).
 *
 * Cycle law (see docs/decisions.md, eval-cluster extraction entry):
 * - Top-level requires here must be leaves only. `./sceneValidator` and
 *   `./entityConsistency` MUST stay lazy at their call sites — both reach
 *   entityConsistency, which top-level-requires ./images, which top-level
 *   requires this module.
 * - Back-edges into images.js (callGrokVisionAPI, GEMINI_SAFETY_SETTINGS,
 *   compressedRefCache/hashImageData/compressImageToJPEG) are lazy
 *   require('./images') at the call sites. compressedRefCache is a
 *   SINGLE-INSTANCE shared LRU living in images.js — never duplicate it here.
 *
 * NOTE: do not bare-require this module in one-shot scripts without
 * process.exit(0) — the transitive require graph opens handles that keep
 * the process alive.
 */

const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');
const { log } = require('../utils/logger');
const { PROMPT_TEMPLATES, fillTemplate, promptSections } = require('../services/prompts');
const { assertPromptFilled, guardPromptString } = require('../services/prompts');
const { MODEL_DEFAULTS, withRetry } = require('./textModels');
const { TEXT_MODELS, GROK_VISION_FALLBACK } = require('../config/models');
const r2Lib = require('./r2');

// storyHelpers functions (lazy-loaded to avoid circular dependencies)
let storyHelpersModule = null;
function getStoryHelpers() {
  if (!storyHelpersModule) {
    storyHelpersModule = require('./storyHelpers');
  }
  return storyHelpersModule;
}

// ONE NAME-MATCHING RULE (2026-09-13). Five competing rules used to decide
// whether two cast tokens meant the same person; `castResolver` is the single
// one. Every consumer here states which of the two categories it is:
//   RESOLVE — a brief/roster token → an entity (resolveEntity/sameEntity)
//   COMPARE — two stored names from the SAME run (canonicalName equality only)
// Lazy for the same circular-dependency reason as storyHelpers.
let castResolverModule = null;
function getCastResolver() {
  if (!castResolverModule) {
    castResolverModule = require('./castResolver');
  }
  return castResolverModule;
}

// Quality-eval sampling knobs (env-overridable for A/B). Defaults chosen from
// a local variance test on job_1781310332569 p4 (4 runs × 3 configs):
//   temp 0.3 + thinking 8192 (old): mean 6.3 issues, count spread 4 (noisy)
//   temp 0   + thinking 8192      : mean 9.3 issues — thinking OVER-flags
//   temp 0   + thinking 0  (this) : mean 4.5 issues, count spread 1 — stable
//                                   AND finds the real issues, not invented ones
// Temperature 0 stabilises the issue count; thinking off stops the structured
// detection check from rationalising extra "problems" (it permanently
// condemns good images). Semantic / three-stage evals are unaffected — they
// keep their own calls and can keep thinking where reasoning genuinely helps.
const { EVAL_TEMPERATURE } = require('../config/models');
const { FINDING_SOURCES, stampFindingSource } = require('./findingSources');
const { assessImageResponse, describeImageBlock } = require('./imageReplyGuard');
const EVAL_THINKING_BUDGET = process.env.EVAL_THINKING_BUDGET != null ? Number(process.env.EVAL_THINKING_BUDGET) : 0;

// Quality threshold from environment or default
// MANUAL admin repair workflow STOP condition -- PINNED at 50, deliberately NOT
// REPAIR_DEFAULTS.scoreThreshold (owner, 2026-09-09). The pipeline floor moved
// 50 -> 60 for AUTOMATIC repair rounds; deriving this from it would silently make
// operator-driven "repair until good" grind every page up to 60 and multiply the
// cost of a manual session. Operator behaviour is unchanged.
const MANUAL_REPAIR_STOP_SCORE = 50;
const IMAGE_QUALITY_THRESHOLD = parseFloat(process.env.IMAGE_QUALITY_THRESHOLD) || MANUAL_REPAIR_STOP_SCORE;

/**
 * Run P1 Visual Inventory — honest figure/age detection without seeing the original prompt.
 * Returns parsed inventory data or null on failure. No scoring, no P2 follow-up.
 *
 * P1 does NOT name anyone. Identity needs the character contract — descriptions,
 * the clothing requirements, declared positions — and P1 is prompt-blind by
 * design, so it has none of it. The quality evaluator owns `matches[]`.
 *
 * @param {Array} parts - The generated image only (no reference photos, no text prompt)
 * @param {string} modelId - Gemini model to use
 * @param {string} apiKey - Gemini API key
 * @param {string} pageContext - Page context for logging
 * @returns {Promise<{figures: Array, objectMatches: Array, rendering: Object, inputTokens: number, outputTokens: number}|null>}
 */
async function runVisualInventory(parts, modelId, apiKey, pageContext, opts = {}) {
  try {
    // promptOverride / raw exist for the Lab inventory A/B: the SAME call
    // machinery (retries, Grok fallback, safety settings, temperature)
    // measuring a different template, rather than a second hand-rolled caller
    // that drifts from this one. `raw` returns the model's text unparsed, which
    // is the only way to measure a prose template against a JSON one.
    const inventoryPrompt = opts.promptOverride || PROMPT_TEMPLATES.imageInventoryUnified;
    const inventoryParts = [...parts];
    inventoryParts.push({ text: inventoryPrompt });
    assertPromptFilled(inventoryParts, 'runVisualInventory');

    // Route to Grok vision API for xAI models
    let modelConfig = TEXT_MODELS[modelId];
    let p1Response = null;
    if (modelConfig?.provider === 'openrouter') {
      // OpenRouter vision judge (Qwen3-VL on staging — runtime.js
      // `inventoryModel`). Same response shape as the Grok path. A failed,
      // stalled or errored call FALLS BACK TO GEMINI 2.5 FLASH (owner,
      // 2026-09-07): the inventory is on every page's critical path and the
      // single upstream provider stalled 3 of 20 Lab pages (experiment 1053).
      const pageLabel = pageContext ? `[${pageContext}] ` : '';
      try {
        p1Response = await require('./images').callOpenRouterVisionAPI(modelId, modelConfig.modelId || modelId, inventoryParts, inventoryPrompt, { reasoning: opts.reasoning || null });
      } catch (e) {
        log.warn(`⚠️ [QUALITY P1] ${pageLabel}${modelId} threw (${e.message}) — falling back to gemini-2.5-flash`);
        p1Response = null;
      }
      if (p1Response && !p1Response.ok) {
        log.warn(`⚠️ [QUALITY P1] ${pageLabel}${modelId} returned HTTP ${p1Response.status} — falling back to gemini-2.5-flash`);
        p1Response = null;
      }
      if (!p1Response) {
        modelId = 'gemini-2.5-flash';
        modelConfig = TEXT_MODELS[modelId];
      }
    }
    if (p1Response) {
      // OpenRouter answered — nothing more to fetch.
    } else if (modelConfig?.provider === 'xai') {
      p1Response = await require('./images').callGrokVisionAPI(modelId, modelConfig.modelId || modelId, inventoryParts, inventoryPrompt);
    } else {
      p1Response = await withRetry(async () => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: inventoryParts }],
            // Same rationale as the quality-eval budget bump — inventory (P1)
            // stage emits detailed per-figure JSON that can run long on
            // multi-character scenes.
            // thinkingBudget 0, same as the quality call next door. Without it
            // Gemini thinks dynamically and can spend the whole 32k budget
            // there, emitting truncated JSON: measured on a 12-figure page in
            // Lab #817, where the inventory ended mid-figure at `"id": 5` after
            // only 1,280 visible output tokens and parsed to zero figures.
            // No maxOutputTokens (owner rule: no output caps) — Gemini's default
            // is the model's own ceiling; finishReason MAX_TOKENS is checked below.
            generationConfig: {
              temperature: EVAL_TEMPERATURE,
              thinkingConfig: { thinkingBudget: EVAL_THINKING_BUDGET },
            },
            safetySettings: require('./images').GEMINI_SAFETY_SETTINGS
          })
        });
      }, { maxRetries: 2, baseDelay: 2000 });
    }

    if (!p1Response.ok) {
      const errText = await p1Response.text();
      const pageLabel = pageContext ? `[${pageContext}] ` : '';
      log.warn(`⚠️ [QUALITY P1] ${pageLabel}API error: ${errText.substring(0, 200)}`);
      // Persistent HTTP failure (after withRetry already burned its 2 retries).
      // Fall back to Grok vision so a transient Gemini outage doesn't degrade
      // the page's eval. Same fallback path as the safety-block branch below.
      if (modelConfig?.provider !== 'xai') {
        const grokFallbackId = GROK_VISION_FALLBACK;
        const grokFallbackModel = TEXT_MODELS[grokFallbackId];
        if (grokFallbackModel?.provider === 'xai') {
          log.info(`🔄 [QUALITY P1] ${pageLabel}Falling back to Grok vision (${grokFallbackId}) after HTTP error...`);
          try {
            const grokResp = await require('./images').callGrokVisionAPI(grokFallbackId, grokFallbackModel.modelId || grokFallbackId, inventoryParts, inventoryPrompt);
            if (grokResp.ok) {
              p1Response = grokResp;
              // `modelId` is what the caller is told ACTUALLY answered
              // (servedByModel, recorded by the Lab at testlab.js:6546). Leaving
              // it on the requested id makes an A/B compare a model with itself.
              modelId = grokFallbackId;
              modelConfig = grokFallbackModel;
            } else {
              return null;
            }
          } catch (grokErr) {
            log.warn(`⚠️ [QUALITY P1] ${pageLabel}Grok fallback failed: ${grokErr.message}`);
            return null;
          }
        } else {
          return null;
        }
      } else {
        return null;
      }
    }

    let p1Data = await p1Response.json();
    let inputTokens = p1Data.usageMetadata?.promptTokenCount || 0;
    let outputTokens = p1Data.usageMetadata?.candidatesTokenCount || 0;
    const thinkingTokens = p1Data.usageMetadata?.thoughtsTokenCount || 0;

    // ALLOW-LIST since 2026-09-18 (imageReplyGuard): a finish reason must MEAN
    // the model finished, or the inventory is treated as blocked and routed to
    // the Grok fallback below. The old test named SAFETY and PROHIBITED_CONTENT
    // only, so RECITATION / BLOCKLIST / SPII / LANGUAGE / OTHER / the IMAGE_*
    // family reached the `!p1Text` return instead — the page lost its visual
    // inventory entirely rather than getting a second opinion. MAX_TOKENS stays
    // OUT of this: it has its own named check a few lines down.
    const p1Block = assessImageResponse(p1Data);
    const p1Blocked = p1Block.blocked;

    if (p1Blocked) {
      const pageLabel = pageContext ? `[${pageContext}] ` : '';
      log.warn(`⚠️ [QUALITY P1] ${pageLabel}Inventory ${describeImageBlock(p1Block)}`);
      // Fall back to Grok vision if we weren't already using xAI
      if (modelConfig?.provider !== 'xai') {
        const grokFallbackId = GROK_VISION_FALLBACK;
        const grokFallbackModel = TEXT_MODELS[grokFallbackId];
        if (grokFallbackModel?.provider === 'xai') {
          log.info(`🔄 [QUALITY P1] ${pageLabel}Falling back to Grok vision (${grokFallbackId})...`);
          try {
            const grokResp = await require('./images').callGrokVisionAPI(grokFallbackId, grokFallbackModel.modelId || grokFallbackId, inventoryParts, inventoryPrompt);
            if (grokResp.ok) {
              p1Data = await grokResp.json();
              // Same reason as the HTTP-error fallback above: report the model
              // that answered, not the one that was asked.
              modelId = grokFallbackId;
              modelConfig = grokFallbackModel;
              inputTokens = p1Data.usageMetadata?.promptTokenCount || 0;
              outputTokens = p1Data.usageMetadata?.candidatesTokenCount || 0;
              if (p1Data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                log.info(`✅ [QUALITY P1] ${pageLabel}Grok fallback succeeded`);
              } else {
                log.warn(`⚠️ [QUALITY P1] ${pageLabel}Grok fallback returned no text`);
                return null;
              }
            } else {
              return null;
            }
          } catch (grokErr) {
            log.warn(`⚠️ [QUALITY P1] ${pageLabel}Grok fallback failed: ${grokErr.message}`);
            return null;
          }
        } else {
          return null;
        }
      } else {
        return null;
      }
    }

    const p1Text = p1Data.candidates[0]?.content?.parts?.[0]?.text?.trim();
    if (!p1Text) {
      log.warn(`⚠️ [QUALITY P1] No text response`);
      return null;
    }
    // A MAX_TOKENS inventory is a cut figure list — it parsed to zero figures
    // on Lab #817 and read as "no figures". Fail with the reason, not silently.
    if (p1Data.candidates[0]?.finishReason === 'MAX_TOKENS') {
      log.warn(`⚠️ [QUALITY P1] ${pageContext ? `[${pageContext}] ` : ''}evalFailed: inventory TRUNCATED (finishReason=MAX_TOKENS at ${outputTokens} output tokens) — figures unusable`);
      return null;
    }

    // `modelId` is reassigned by the fallbacks above, so it is the model that
    // ACTUALLY answered — which the caller has no other way to learn. Lab #1241
    // requested gemini-3.7-flash, every call 400'd ("reasoning is mandatory"),
    // the documented 2.5-flash fallback served all 10 pages, and the experiment
    // row still said 3.7: an A/B comparing a model with itself, caught only
    // because the token counts came back byte-identical to the 2.5 arm.
    if (opts.raw) return { rawText: p1Text, inputTokens, outputTokens, servedByModel: modelId };

    let inventoryJson;
    try {
      inventoryJson = getStoryHelpers().extractJsonFromText(p1Text);
    } catch (e) {
      log.warn(`⚠️ [QUALITY P1] JSON parse failed`);
      return null;
    }
    if (!inventoryJson) {
      log.warn(`⚠️ [QUALITY P1] No JSON in response`);
      return null;
    }

    // Boxes on the inventory's own scale contract (0-1). Qwen3-VL mixes
    // 0-1000 pixel values into the same array; every provider passes through
    // here so the pairing downstream never sees a mixed box.
    const boxStats = require('./inventoryBoxes').normaliseInventoryBoxes(inventoryJson);
    if (boxStats.fixed || boxStats.dropped) {
      log.info(`📊 [EVAL P1] ${modelId}: normalised ${boxStats.fixed} box(es) from 0-1000 scale, dropped ${boxStats.dropped} malformed`);
    }

    const thinkingInfo = thinkingTokens > 0 ? `, thinking: ${thinkingTokens.toLocaleString()}` : '';
    log.verbose(`📊 [EVAL P1] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}${thinkingInfo}`);

    const figures = inventoryJson.figures || [];
    if (figures.length > 0) {
      log.info(`📊 [EVAL P1] Figures: ${figures.map(f => `#${f.id} ${f.hair} (${f.position})`).join('; ')}`);
    }

    return {
      figures,
      servedByModel: modelId,
      // Everything the unified template produces travels with it. The narrowed
      // return is what made P1's scene_summary generated-and-discarded on every
      // page since February, and it would have silently dropped interactions,
      // setting and lettering the moment the compliance judge started reading
      // this object instead of prose.
      interactions: inventoryJson.interactions || [],
      objects: inventoryJson.objects || [],
      objectMatches: inventoryJson.object_matches || inventoryJson.objects || [],
      setting: inventoryJson.setting || null,
      lettering: inventoryJson.lettering || [],
      rendering: inventoryJson.rendering || {},
      sceneSummary: inventoryJson.scene_summary || null,
      mainAction: inventoryJson.main_action || null,
      inputTokens,
      outputTokens
    };
  } catch (err) {
    log.warn(`⚠️ [QUALITY P1] Figure check failed: ${err.message}`);
    return null;
  }
}

/**
 * Largest contiguous INTERIOR uniform patch, as a fraction of all blocks.
 *
 * Why not a bare count (the 2026-09-14 fix): the old check summed uniform
 * blocks ANYWHERE and compared that to the threshold, so a watercolour paper
 * border — a thin uniform band hugging the perimeter, an intended part of the
 * art style — accumulated enough blocks to trip it even though no rectangular
 * glitch existed in the picture. A real AI box artifact is a CONTIGUOUS patch
 * sitting in the interior; a border, vignette or deckle edge is a band on the
 * rim. So we discriminate on shape and position.
 *
 * Two steps, in this order:
 *  1. Peel a perimeter band. From each of the four sides inward, a line is
 *     peeled only while it is uniform ACROSS ITS WHOLE SPAN. That is the
 *     deliberately conservative part: a border runs edge to edge, a glitch
 *     does not — so an artifact that merely touches an edge is never peeled
 *     (this is why we do not just ignore all edge blocks). Peeling is capped at
 *     15% of the dimension so an entirely uniform frame — blank or broken —
 *     still leaves a large interior and is still flagged.
 *  2. Take the largest 4-connected component of what survives. Scattered
 *     uniform blocks summing past the threshold are not a box and no longer
 *     fire; a genuine box is one component and is unaffected.
 *
 * The denominator stays the full block count, so the 0.08 threshold keeps its
 * original meaning for an interior patch.
 */
function largestInteriorUniformFraction(mask, rows, cols) {
  const total = rows * cols;
  if (total === 0) return 0;
  const frame = new Uint8Array(total);
  const maxR = Math.max(1, Math.floor(rows * 0.15));
  const maxC = Math.max(1, Math.floor(cols * 0.15));

  const rowUniform = (r) => { for (let c = 0; c < cols; c++) if (!mask[r * cols + c]) return false; return true; };
  const colUniform = (c) => { for (let r = 0; r < rows; r++) if (!mask[r * cols + c]) return false; return true; };
  const markRow = (r) => { for (let c = 0; c < cols; c++) frame[r * cols + c] = 1; };
  const markCol = (c) => { for (let r = 0; r < rows; r++) frame[r * cols + c] = 1; };

  for (let t = 0; t < maxR && rowUniform(t); t++) markRow(t);
  for (let t = 0; t < maxR && rowUniform(rows - 1 - t); t++) markRow(rows - 1 - t);
  for (let t = 0; t < maxC && colUniform(t); t++) markCol(t);
  for (let t = 0; t < maxC && colUniform(cols - 1 - t); t++) markCol(cols - 1 - t);

  // Largest 4-connected component of the un-peeled uniform blocks.
  const seen = new Uint8Array(total);
  const stack = [];
  let best = 0;
  for (let start = 0; start < total; start++) {
    if (!mask[start] || frame[start] || seen[start]) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    let size = 0;
    while (stack.length) {
      const i = stack.pop();
      size++;
      const r = Math.floor(i / cols);
      const c = i - r * cols;
      const nbrs = [r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1, c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1];
      for (const n of nbrs) {
        if (n < 0 || seen[n] || !mask[n] || frame[n]) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (size > best) best = size;
  }
  return best / total;
}

/**
 * Build the empty-scene QC prompt (prompts/empty-scene-qc.txt).
 *
 * Extracted from validateEmptyScene 2026-09-15 so the built prompt can be
 * asserted without a paid vision call, and so the plate generator/critic pair
 * names two file paths instead of this module.
 */
function buildEmptySceneQcPrompt({ sceneDescription = '', storyEra = null, characterPlacements = null, mainScenePrompt = '' } = {}) {
  const sceneCtx = sceneDescription
    ? `\nEXPECTED SCENE: "${sceneDescription.substring(0, 300)}"`
    : '';
  // Era context — explicit period so the vision model doesn't have to
  // infer it. Caller derives this from storyType + costumed clothing.
  // "present-day" (or null) disables the anachronism check.
  const eraBlock = storyEra
    ? `\n\nSTORY ERA: ${storyEra} — render accordingly. Landmark reference photos are present-day; any modern elements visible in the photo must NOT appear in the output.`
    : '';
  // If the outline already declared where each character will land, ask
  // the vision model to verify the empty scene has flat usable space at
  // each of those spots — not blocked by walls, props, or scene edges.
  const placementsBlock = Array.isArray(characterPlacements) && characterPlacements.length > 0
    ? `\n\nCHARACTER PLACEMENTS TO BE COMPOSITED LATER:\n${characterPlacements.map(p => `- ${p.name || 'character'} at ${p.position || 'unspecified'}${p.depth ? ` (depth: ${p.depth})` : ''}`).join('\n')}`
    : '';
  // The judge's own text is prompts/empty-scene-qc.txt (sections BODY /
  // ERA_CHECK / PLACEMENTS_CHECK), so the plate generator/critic pair is
  // a registry set over two file paths. The conditional checks keep the
  // leading newline here; the section bodies are trimmed.
  const qc = promptSections(PROMPT_TEMPLATES.emptySceneQc);
  // Loud, not empty: as a string literal a missing prompt was impossible; as a
  // file it would hand the judge a blank page and every plate would "pass".
  if (!qc.BODY) throw new Error('buildEmptySceneQcPrompt: empty-scene-qc template not loaded');
  const placementsCheck = placementsBlock ? `\n${qc.PLACEMENTS_CHECK}` : '';
  // Composition geometry fidelity — the main scene will composite
  // characters and aim lines onto this empty scene. If the path
  // direction or vanishing point in the empty scene doesn't match what
  // the main scene prose describes, the composite will be broken.
  //
  // NO RESERVED CORNER (owner, 2026-09-15: "Why does the empty scene
  // need a reserved corner that is wrong. Change the judge."). The
  // page's text area is computed later from the calmness map
  // (server/lib/textRegion.js), so the plate reserves nothing.
  //
  // The three geometry checks below DO reach the generator since
  // 2026-09-15: buildEmptyScenePrompt derives a geometry-only block
  // from this same mainScenePrompt (server/lib/sceneGeometry.js), so
  // the plate is graded on facts it was given. Adding a check here
  // that is not derivable into that block re-creates the blind grade.
  const mainSceneBlock = mainScenePrompt
    ? `\n\nMAIN SCENE PROSE (what will be composited onto this empty scene):\n"${mainScenePrompt.substring(0, 800)}"`
    : '';
  // The judge's three geometry questions come from the SAME constant
  // that writes the plate author's geometry block
  // (GEOMETRY_DIMENSIONS, server/lib/sceneGeometry.js), so the two
  // sides name the same dimensions in the same words. A fourth check
  // belongs in that constant, never inline here.
  // Only the dimensions the plate AUTHOR was handed. `selectGeometryFacts`
  // runs the same scan `extractSceneGeometry` runs for the generator, over
  // the same prose and the same cast, so a dimension the prose never states
  // is asked of neither side. Grading a dimension the author was not given
  // is exactly the blind grade sceneGeometry.js was built to end.
  const { selectGeometryFacts, buildGeometryJudgeChecks } = require('./sceneGeometry');
  const geometryCheck = mainScenePrompt
    ? buildGeometryJudgeChecks(5, selectGeometryFacts({
        mainScenePrompt,
        castNames: Array.isArray(characterPlacements) ? characterPlacements.map(c => c && c.name).filter(Boolean) : [],
      }).dims)
    : '';
  return fillTemplate(qc.BODY, {
    SCENE_CTX: sceneCtx,
    ERA_BLOCK: eraBlock,
    PLACEMENTS_BLOCK: placementsBlock,
    MAIN_SCENE_BLOCK: mainSceneBlock,
    ERA_CHECK: storyEra ? `\n${qc.ERA_CHECK}` : '',
    PLACEMENTS_CHECK: placementsCheck,
    GEOMETRY_CHECK: geometryCheck,
  });
}

/**
 * Validate an empty scene (background-only) image.
 * Two-phase check:
 * Phase 1 (pixel): calmness heatmap — white boxes, too dark, text area readiness (<50ms, free)
 * Phase 2 (vision): Gemini Flash-lite — people/figures, setting/geometry/anachronism issues (no landmark-identity check) (~2s, cheap)
 *
 * @param {string} imageData - base64 data URI
 * @param {string} textPosition - e.g. 'top-right'
 * @param {string} pageContext - logging context
 * @param {object} [options]
 * @param {string} [options.sceneDescription] - expected scene description (for landmark check)
 * @param {boolean} [options.skipVision=false] - skip the Gemini vision check (pixel only)
 * @returns {{ pass: boolean, issues: string[], calmnessScore: number, visionFeedback: string|null }}
 */
async function validateEmptyScene(imageData, textPosition, pageContext = '', options = {}) {
  const { sceneDescription = null, skipVision = false, characterPlacements = null, mainScenePrompt = null, storyEra = null } = options;
  try {
    const base64 = r2Lib.stripDataUriPrefix(imageData);
    const buf = Buffer.from(base64, 'base64');
    const { data: pixels, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;

    const BLOCK = 16;
    const rows = Math.floor(height / BLOCK);
    const cols = Math.floor(width / BLOCK);
    if (rows < 4 || cols < 4) return { pass: true, issues: [], calmnessScore: 0.5 };

    // Compute per-block brightness and variance
    const blockBrightness = new Float32Array(rows * cols);
    const blockVariance = new Float32Array(rows * cols);
    let totalBrightness = 0;
    let vMax = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0, sumSq = 0;
        const count = BLOCK * BLOCK;
        for (let by = 0; by < BLOCK; by++) {
          const off = (r * BLOCK + by) * width;
          for (let bx = 0; bx < BLOCK; bx++) {
            const val = pixels[off + c * BLOCK + bx];
            sum += val;
            sumSq += val * val;
          }
        }
        const mean = sum / count;
        const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
        blockBrightness[r * cols + c] = mean;
        blockVariance[r * cols + c] = std;
        totalBrightness += mean;
        if (std > vMax) vMax = std;
      }
    }

    const avgBrightness = totalBrightness / (rows * cols) / 255;
    if (vMax === 0) vMax = 1;

    const issues = [];

    // Check 1: uniform-patch artifact detection — a flat white OR a flat
    // black rectangle is an AI glitch regardless of the expected tone. Flag
    // either if it exceeds the artifact threshold.
    const whiteMask = new Uint8Array(rows * cols);
    const blackMask = new Uint8Array(rows * cols);
    for (let i = 0; i < rows * cols; i++) {
      if (blockBrightness[i] > 240 && blockVariance[i] < 5) whiteMask[i] = 1;
      if (blockBrightness[i] < 15 && blockVariance[i] < 5) blackMask[i] = 1;
    }
    // Shape and position, not a bare count: the fraction is the LARGEST
    // 4-connected uniform patch left after a full-width/height perimeter band
    // is peeled off. Both twins get it — a dark deckle edge false-positives the
    // black check exactly as a watercolour paper border did the white one.
    const whiteBoxPct = largestInteriorUniformFraction(whiteMask, rows, cols);
    const blackBoxPct = largestInteriorUniformFraction(blackMask, rows, cols);
    if (whiteBoxPct > 0.08) {
      issues.push(`white box artifact: ${(whiteBoxPct * 100).toFixed(0)}% of image is uniform white`);
    }
    if (blackBoxPct > 0.08) {
      issues.push(`black box artifact: ${(blackBoxPct * 100).toFixed(0)}% of image is uniform black`);
    }

    // Check 2: overall too dark — darker scenes are now expected (white text on
    // dark backdrop), so the floor drops to 8%. Below that the frame is blank
    // or broken, not an artistic choice.
    if (avgBrightness < 0.08) {
      issues.push(`too dark: average brightness ${(avgBrightness * 100).toFixed(0)}%`);
    }

    // Check 3: text area calmness — smooth (low-variance) zone for text placement.
    // Previously this also rewarded darkness, but the prompt/text-overlay design
    // no longer requires a dark zone — the white-wash composited at render time
    // handles contrast. Pure smoothness is what matters: a bright clear sky or
    // a saturated flat wall are both fine, as long as they're not cluttered.
    let textAreaCalm = 0;
    let textAreaCount = 0;
    const isTop = textPosition?.startsWith('top');
    const isLeft = textPosition?.includes('left') || textPosition?.includes('full');
    const isFull = textPosition?.includes('full');

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const inVertical = isTop ? r < rows * 0.4 : r > rows * 0.6;
        const inHorizontal = isFull || (isLeft ? c < cols * 0.6 : c > cols * 0.4);
        if (inVertical && inHorizontal) {
          const vNorm = blockVariance[r * cols + c] / vMax;
          textAreaCalm += (1 - vNorm);
          textAreaCount++;
        }
      }
    }
    const calmnessScore = textAreaCount > 0 ? textAreaCalm / textAreaCount : 0;

    // 0.55 threshold tuned for pure-smoothness scoring — a cluttered zone with
    // edges/detail lands ~0.3-0.5, a calm surface ~0.6-0.9. (Previous 0.15
    // threshold was for the dark-rewarding formula and is too lax here.)
    if (calmnessScore < 0.55 && textPosition) {
      issues.push(`text area too busy: calmness ${(calmnessScore * 100).toFixed(0)}% at ${textPosition}`);
    }

    // ── Phase 2: Gemini Flash-lite vision check ──
    // Catches things pixels can't: people/figures, setting mismatch, content errors.
    let visionFeedback = null;
    if (!skipVision && issues.length === 0) {
      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (apiKey) {
          const base64ForVision = r2Lib.stripDataUriPrefix(imageData);
          const mimeType = imageData.match(/^data:(image\/\w+);/)?.[1] || 'image/jpeg';

          const qcPrompt = buildEmptySceneQcPrompt({ sceneDescription, storyEra, characterPlacements, mainScenePrompt });

          const visionUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
          const visionResp = await fetch(visionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [
                { inline_data: { mime_type: mimeType, data: base64ForVision } },
                { text: guardPromptString(qcPrompt, 'validateEmptyScene') }
              ]}],
              generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
              safetySettings: require('./images').GEMINI_SAFETY_SETTINGS
            }),
            signal: AbortSignal.timeout(15000),
          });

          if (visionResp.ok) {
            const visionData = await visionResp.json();
            const visionText = visionData.candidates?.[0]?.content?.parts?.[0]?.text || '';
            try {
              const visionResult = JSON.parse(visionText);
              if (visionResult.pass === false) {
                issues.push(...(visionResult.issues || ['vision check failed']));
                visionFeedback = visionResult.feedback || null;
                log.warn(`❌ [EMPTY-SCENE-QC] ${pageContext} Vision FAILED: ${(visionResult.issues || []).join(', ')}${visionFeedback ? ` — fix: ${visionFeedback}` : ''}`);
              } else {
                log.debug(`✅ [EMPTY-SCENE-QC] ${pageContext} Vision passed`);
              }
            } catch {
              // Unparseable — check for keywords
              if (visionText.toLowerCase().includes('"pass": false') || visionText.toLowerCase().includes('"pass":false')) {
                issues.push('vision check failed (unparseable)');
                visionFeedback = visionText.substring(0, 200);
              }
            }
          }
        }
      } catch (visionErr) {
        log.debug(`⚠️ [EMPTY-SCENE-QC] ${pageContext} Vision check skipped: ${visionErr.message}`);
      }
    }

    const pass = issues.length === 0;
    if (!pass) {
      log.warn(`❌ [EMPTY-SCENE-QC] ${pageContext} FAILED (calmness ${(calmnessScore * 100).toFixed(0)}%): ${issues.join(', ')}`);
    } else {
      log.debug(`✅ [EMPTY-SCENE-QC] ${pageContext} passed (brightness ${(avgBrightness * 100).toFixed(0)}%, text calmness ${(calmnessScore * 100).toFixed(0)}%, white ${(whiteBoxPct * 100).toFixed(0)}%, black ${(blackBoxPct * 100).toFixed(0)}%)`);
    }

    return { pass, issues, calmnessScore, visionFeedback };
  } catch (err) {
    log.warn(`⚠️ [EMPTY-SCENE-QC] ${pageContext} Error: ${err.message} — skipping check`);
    return { pass: true, issues: [], calmnessScore: 0.5, visionFeedback: null };
  }
}

/**
 * Never-CRITICAL gate for the compliance stage's identity-absence findings
 * (docs/decisions.md + models.js "presence-is-input + never-CRITICAL"): the
 * compliance judge never sees the image — a "missing / not identified"
 * character finding from it is an INFERENCE from the identification input
 * (QUALITY_FIGURES.matches[]), not an observed image defect. When the
 * identification stage produced an empty or incomplete matches[] (e.g. no
 * usable reference photos), every named character looks "missing" and each
 * CRITICAL costs 30 pts in the merged recompute → a good cover/page tanks and
 * loops through repair forever, because the repaired image re-evals through
 * the same broken input. The image-seeing quality eval still owns true
 * missing-character CRITICALs, so capping the blind judge at MAJOR loses no
 * real detection power. Enforced in CODE (not only in the prompt) so a model
 * that disobeys its own contract cannot re-open the loop.
 *
 * Mutates severity in place; stamps `severityCapped` for the dev panel.
 * @param {Array<{description: string, severity: string, type: string}>} issues
 * @returns {Array} the same array (for chaining)
 */
function capComplianceIdentitySeverity(issues) {
  if (!Array.isArray(issues)) return issues;
  // Self-contained (no module-scope deps) so unit tests can vm-extract it.
  const identityAbsenceRe = /\bnot identified\b|\bunidentified\b|matches\s*\[\s*\]|\bno (?:entry|match(?:es)?) in\b|\babsent from (?:the )?match/i;
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object') continue;
    const sev = String(issue.severity || '').toUpperCase();
    if (sev !== 'CRITICAL' && sev !== 'CATASTROPHIC') continue;
    const isIdentityAbsence = issue.type === 'missing_character'
      || identityAbsenceRe.test(String(issue.description || ''));
    if (isIdentityAbsence) {
      issue.severity = 'MAJOR';
      issue.severityCapped = 'identity-input'; // eval-input deficiency, not an observed defect
    }
  }
  return issues;
}

/**
 * The prompt-compliance judge. Compares the blind inventory against the original
 * prompt, text-only, never seeing the image. Returns a compliance score (0-100)
 * and fixable issues, or null on failure.
 *
 * THE NAME IS HISTORICAL and does not describe the function. It has never had
 * three stages: the commit that added it (568aacce7) implemented Stage 1 (a
 * blind vision call) and Stage 2 (this judge), counting the pre-existing quality
 * eval as the third. Since the blind inventory became one shared call for the
 * whole page, Stage 1 is not performed here at all — its result arrives as
 * `inventoryPromise` — so what remains is a single stage. Kept as-is
 * deliberately: `threeStageResult` / `threeStageScore` / `threeStage_*_tokens`
 * are persisted on every stored version and read by the dev panel, and renaming
 * the code without them would be worse than the current name.
 *
 * Do not confuse "Stage" with the STEP 1 / 1b / 2 / 3 headings inside
 * `image-prompt-compliance.txt` — those are steps within this one stage.
 *
 * @param {string} imageData - Base64 encoded image with data URI prefix
 * @param {string} imagePrompt - The prompt used to generate the image
 * @param {string|null} sceneHint - Original scene description (may contain interaction metadata)
 * @param {Object} options
 * @param {Promise|null} options.inventoryPromise - The shared blind inventory for this page
 * @param {string} options.pageContext - Page context for logging (e.g., "PAGE 5")
 * @returns {Promise<Object|null>} Three-stage result or null on failure
 */
async function evaluateThreeStage(imageData, imagePrompt, sceneHint, options = {}) {
  const {
    pageContext = '',
    storyText = null,
    qualityFiguresPromise = null,
    inventoryPromise = null,          // the ONE blind inventory, shared with the figures merge
    expectedAges = '',                // declared age per character, joined to the blind read by name
    complianceModelOverride = null,   // Stage-2 model A/B (default evalModel = qwen-plus)
    compliancePromptOverride = null,  // Stage-2 template A/B
    artStyle = null,                  // resolved style — same value the quality eval gets
    clothingContract = null,          // per-character outfit block — same value the quality eval gets
    // THE ROSTER, FOR A BLIND JUDGE (2026-09-14). `buildExpectedCastBlock`'s
    // block, kind labels and all — the same string the quality evaluator gets.
    // Without it this judge had no cast list at all and improvised a label for
    // any orphan it could not pair, which is how one animal drew
    // `missing_character`, `extra_character` and `duplicate_identity` on one
    // story. '' keeps the pre-roster behaviour: judge membership from the prompt.
    expectedCast = '',
    // Era-aware landmark protection (2026-09-05). A page rendered from a real
    // landmark photo in a present-day story must not have that landmark's
    // structures classified as unrequested/modern; a historical page keeps the
    // era guard's semantics so modern infrastructure stays a finding.
    landmarkPhotos = null,
    era = null,
    // Resolves raw VB ids out of the INTERACTIONS_BLOCK below. Optional: a
    // caller without a bible still gets the ids replaced by generic nouns.
    visualBible = null,
    // REQUIRED TEXT allow-list, built ONCE in evaluateImageQuality and handed
    // to all three judges (requiredText.buildRequiredTextRulesBlock). Empty
    // when the page declares no readable lettering -- the templates then keep
    // the plain no-lettering rule. Never a second hand-written copy.
    textRules = '',
  } = options;
  const { computeLandmarkProtection, buildLandmarkContextBlock, filterProtectedRemovals } = require('./landmarkProtection');
  const landmarkProtection = computeLandmarkProtection({ landmarkPhotos, era });
  const pageLabel = pageContext ? `[${pageContext}] ` : '';
  // A dimension this judge could not look at is part of its RESULT, not only a
  // log line (2026-09-14). Recording only — never a deduction. See notEvaluated.js.
  const notEvaluated = require('./notEvaluated').createNotEvaluatedRecorder({ pageContext });

  // No vision template here any more: Stage 1 is the shared blind inventory,
  // produced by the single call in evaluateImageQuality and handed in.
  const complianceTemplate = compliancePromptOverride || PROMPT_TEMPLATES.imagePromptCompliance;

  if (!complianceTemplate) {
    log.warn(`[THREE-STAGE] ${pageLabel}Compliance template not loaded, skipping`);
    return null;
  }

  // Extract interactions from sceneHint for Stage 2.
  // `i.object` is a raw Visual Bible id. Built inline here, it put "ART001" in
  // front of the compliance judge, which quotes it back in its own finding
  // prose — and those findings are what the consolidator reads and turns into
  // a Grok instruction. formatInteractionsBlock is the one builder for this
  // line across all three evaluators (vbIdGuard.js).
  let interactionsBlock = '(none declared)';
  try {
    const { extractSceneMetadata } = getStoryHelpers();
    const meta = extractSceneMetadata(sceneHint || imagePrompt);
    const interactions = meta?.interactions
      || (Array.isArray(meta?.fullData?.interactions) ? meta.fullData.interactions : null);
    interactionsBlock = require('./vbIdGuard').formatInteractionsBlock(interactions, visualBible, require('./vbIdGuard').gazeCharacters(meta));
  } catch { /* silent */ }

  // --- Stage 1: the SHARED blind inventory ---
  // Stage 1 used to make its own call with its own prompt. It was the second
  // blind describer on every page: P1 (JSON, read by code) and this one (prose,
  // read by the compliance judge) listed the same figures from the same picture.
  // They were never a designed pair - P1 is the surviving half of a two-pass
  // eval deleted in Feb 2026 (e88b3cf50) and this stage rebuilt the same shape
  // seven weeks later beside it (568aacce7). Both now come from ONE call whose
  // result is passed in, so the judge and the code read the same observation.
  let visionText = null;
  let stage1Usage = { input_tokens: 0, output_tokens: 0 };
  try {
    const inventory = inventoryPromise ? await inventoryPromise : null;
    if (!inventory) {
      log.warn(`[THREE-STAGE] ${pageLabel}No shared inventory available, skipping`);
      return null;
    }
    stage1Usage = { input_tokens: inventory.inputTokens || 0, output_tokens: inventory.outputTokens || 0 };
    // The judge reads JSON now rather than prose. Its figures carry the same
    // 9-zone vocabulary it always paired on, plus the label it resolves to a
    // real name in STEP 1.
    visionText = JSON.stringify({
      figures: inventory.figures || [],
      interactions: inventory.interactions || [],
      objects: inventory.objects || inventory.objectMatches || [],
      setting: inventory.setting || null,
      lettering: inventory.lettering || [],
      rendering: inventory.rendering || {},
    }, null, 2);
    log.info(`[THREE-STAGE] ${pageLabel}Stage 1 shared inventory: ${(inventory.figures || []).length} figure(s), ${visionText.length} chars`);
  } catch (err) {
    log.warn(`[THREE-STAGE] ${pageLabel}Stage 1 failed: ${err.message}`);
    return null;
  }

  // --- Stage 2: Prompt compliance with Sonnet (text only, NO image) ---
  let complianceResult = null;
  let stage2Usage = { input_tokens: 0, output_tokens: 0 };
  try {
    // If quality eval is producing its own figures[] + matches[], wait for those
    // so Stage 2 can pair named figures (quality) with independent descriptions (vision)
    // using the shared 9-zone vocabulary. If quality eval isn't running or fails,
    // pass an empty block and Stage 2 falls back to vision-only reasoning.
    let qualityFiguresBlock = '(not available)';
    // THREE STATES, NOT TWO. The figures pass either could not be read at all,
    // or it was read and this page genuinely has nobody in it. Collapsing the
    // second into the first is the very confusion notEvaluated.js exists to
    // remove, one level down: staging job_1789584708605_rts4wqupm p3 is a
    // people-free close-up ("the object alone", `characters: []`, zero detected
    // figures) and it was filed as a judge that could not run.
    let figuresRead = false;
    if (qualityFiguresPromise) {
      try {
        const qf = await qualityFiguresPromise;
        figuresRead = !!qf;
        if (qf && (qf.figures?.length || qf.matches?.length)) {
          qualityFiguresBlock = JSON.stringify({
            figures: qf.figures || [],
            matches: qf.matches || [],
          }, null, 2);
        }
      } catch (e) {
        log.debug(`[THREE-STAGE] ${pageLabel}quality figures unavailable: ${e.message}`);
      }
    }
    if (qualityFiguresBlock === '(not available)') {
      // Stage 2 falls back to vision-only reasoning either way, so the pairing
      // is unjudged either way — the REASON is what differs, and the reason is
      // what an analyst reads back out of stored data.
      if (figuresRead) {
        notEvaluated.record('identity_attribution', 'no_figures_on_page',
          'The figures pass returned no figure and no match - this page has nobody to pair a name to');
      } else {
        notEvaluated.record('identity_attribution', 'quality_figures_unavailable',
          'Stage 2 received no figures/matches - named-figure to description pairing was not judged');
      }
    }

    const complianceInput = fillTemplate(complianceTemplate, {
      // THE WHOLE PROMPT (2026-09-14). This was `.substring(0, 3000)`. Real page
      // prompts run 5,400-8,000 chars and a cast member introduced late in the
      // prose sat past the cut — measured on one 18-page story, the animal's own
      // block landed at chars 3,914-5,565 on five of its six pages, so the judge
      // read a prompt that never named it and filed the figure it could not
      // place as extra/absent. An arbitrary input cut on a judge is the same
      // species of bug as an output cap: removed, not enlarged.
      ORIGINAL_PROMPT: imagePrompt || '',
      // Passed separately as well: the ART STYLE and CLOTHING blocks are spec,
      // not prose, and each judge receives them explicitly rather than hoping to
      // find them inside the prompt (a steampunk cover's goggles drew a CRITICAL
      // when the truncation hid them).
      ART_STYLE: artStyle || require('../services/prompts').extractArtStyle(imagePrompt),
      CLOTHING_CONTRACT: clothingContract || '',
      EXPECTED_AGES: expectedAges || '',
      VISUAL_INVENTORY: visionText,
      QUALITY_FIGURES: qualityFiguresBlock,
      EXPECTED_CAST: expectedCast || '',
      INTERACTIONS_BLOCK: interactionsBlock,
      STORY_TEXT: (storyText || '(not provided)').substring(0, 2000),
      LANDMARK_CONTEXT: buildLandmarkContextBlock(landmarkProtection) || '(none)',
      TEXT_RULES: textRules || '',
      // ONE rule for every template that authors or judges a page against its
      // text (promptBuilders.TEXT_NOT_A_CHECKLIST_RULE, 2026-09-18). This
      // judge's STORY_TEXT DECLARES NOTHING block already covered a character
      // named only in the text and a line of dialogue; it never covered the
      // owner's other half — a text naming three actions where the frame
      // stages one.
      TEXT_NOT_A_CHECKLIST: require('./promptBuilders').TEXT_NOT_A_CHECKLIST_RULE,
    });

    const { callTextModel } = require('./textModels');
    // Stage 2 was Sonnet — Haiku didn't reliably follow the "ignore prose
    // decoration unless it's a DECLARED INTERACTION" rule and kept flagging
    // false-positive gaze/facing issues that drove pointless repair rounds.
    // Now configurable (resolveEvalModel, key-guarded to sonnet). NOTE: this is
    // quality-critical and NOT yet A/B-validated on Qwen — watch repair churn.
    const complianceModel = complianceModelOverride || require('../config/models').resolveComplianceModel();
    const sonnetResult = await callTextModel(complianceInput, null, complianceModel, { usageLabel: 'semantic_compliance', temperature: EVAL_TEMPERATURE });

    stage2Usage = {
      input_tokens: sonnetResult.usage?.input_tokens || 0,
      output_tokens: sonnetResult.usage?.output_tokens || 0
    };

    // A reply cut at the ceiling is a truncated finding list, not a verdict:
    // record it as a FAILED eval with the reason (textReplyGuard.js), never
    // as "no findings".
    if (sonnetResult.truncation?.suspected) {
      const reason = require('./textModels').describeTruncation(sonnetResult.truncation);
      log.warn(`[THREE-STAGE] ${pageLabel}Stage 2 evalFailed: compliance reply ${reason}`);
      return { evalFailed: true, evalError: `compliance reply ${reason}`, notEvaluated: notEvaluated.list(), usage: { threeStage_input_tokens: stage2Usage.input_tokens, threeStage_output_tokens: stage2Usage.output_tokens } };
    }
    // Parse JSON from compliance response
    const parsed = getStoryHelpers().extractJsonFromText(sonnetResult.text);
    // Gate on the STRUCTURE, not on a score — the prompt no longer returns
    // one. Keying this on parsed.score would make every three-stage eval
    // return null the moment the score field was dropped.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      complianceResult = parsed;
    } else {
      log.warn(`[THREE-STAGE] ${pageLabel}Stage 2 could not parse JSON from Sonnet response`);
      return null;
    }

    log.info(`[THREE-STAGE] ${pageLabel}Stage 2 compliance: ${(complianceResult.fixable_issues || []).length} finding(s), verdict=${complianceResult.verdict || 'N/A'}`);
  } catch (err) {
    log.warn(`[THREE-STAGE] ${pageLabel}Stage 2 failed: ${err.message}`);
    return null;
  }

  // Parse fixable issues from compliance result. Tag with `source: 'three-stage'`
  // so downstream UI can group them separately from the main quality eval — the
  // two evaluators run independently and Sonnet's compliance check often finds
  // different defects than Gemini's quality eval.
  let fixableIssues = [];
  // Findings the landmark guard suppresses below. RECORDING ONLY — like
  // `notEvaluated`, this never joins `fixableIssues` and never reaches the
  // score, the deductions or any issue count (2026-09-19).
  let suppressedIssues = [];
  if (Array.isArray(complianceResult.fixable_issues)) {
    fixableIssues = complianceResult.fixable_issues
      .filter(i => i.description)
      .map(i => ({
        description: i.description,
        severity: i.severity || 'MODERATE',
        type: i.type || 'default',
        fix: i.fix || `Fix: ${i.description}`,
        // WHOSE SENTENCE `fix` IS. When the judge wrote no edit instruction the
        // line above stands one in from the description — and any code that
        // then reads `fix` to decide what the finding MEANS is classifying it
        // from its description prose, which docs/SETTLED.md forbids. The
        // landmark guard's removal-shape detector is exactly such a reader
        // (landmarkProtection.isRemovalShapedFix), so the stand-in is MARKED
        // rather than left indistinguishable. Only the stand-in carries the
        // flag: an ordinary finding's shape is unchanged. Latent, not
        // theoretical — measured 0 of 15 guard fires, so no stored outcome moves.
        ...(i.fix ? {} : { fixAuthored: false }),
        // THE DECLARED SUBJECT (2026-09-18). `landmark_element` is the judge's
        // answer to "is this finding about the real place this page depicts?",
        // and the landmark guard triggers on it. Passed through only when the
        // judge answered — an absent field stays absent, and the guard reads
        // that as UNDECLARED, never as false (landmarkProtection.landmarkSubject).
        ...(i.landmark_element === undefined ? {} : { landmark_element: i.landmark_element }),
        // WHO the finding is about. The compliance template has always emitted
        // this (its fixable_issues example leads with `"character"`), and this
        // mapper silently dropped it — measured, 0 of 308 stored compliance
        // findings carried a subject against ~68% for quality and semantic,
        // which pass theirs through.
        //
        // It is not cosmetic. scoring.deductionClassKey bills per (class,
        // subject), so a subjectless finding falls back to ONE charge per class
        // for the whole page: every character's clothing collapsed into a single
        // charge for the judge that produces the most findings of all (308 of
        // 819) and has the widest per-page point range (28.9). bboxDetection
        // also matches `issue.character` to a figure to aim a repair, so the
        // loss cost targeted repairs too.
        character: i.character || i.name || null,
        // Legacy DISPLAY tag; the Lab groups on it. Provenance is `sources`.
        source: 'three-stage',
        // PROVENANCE (2026-09-14): the one field every emitter stamps, the one
        // the consolidator re-emits, routing reads and scoring passes through.
        sources: [FINDING_SOURCES.COMPLIANCE],
      }));
    // Never-CRITICAL gate on identity-absence findings (see helper above):
    // presence is an INPUT to this blind judge, never its judgment.
    capComplianceIdentitySeverity(fixableIssues);
    // Era-aware landmark guard: on a present-day page carrying a real landmark
    // photo, an `object_presence` removal finding would drive an unmasked
    // whole-frame edit that erases the real place. Dropped here so the penalty
    // never reaches the score either (v0 of job_1788614817116 p2 scored 55
    // against a repaired-and-wrong v1's 83 precisely because of this finding).
    const guarded = filterProtectedRemovals(fixableIssues, landmarkProtection, { pageNumber: pageContext || null, label: '[THREE-STAGE]' });
    fixableIssues = guarded.kept;
    // The guard suppresses the DEDUCTION, not the RECORD: the dropped findings
    // survive here, marked, so stored data shows what the judge actually said.
    suppressedIssues = guarded.suppressed;
  }

  // THE SCORE IS THE DEFECTS (owner, 2026-08-08). Same 0-10 rubric as the
  // visual and semantic evaluators, so all three subscores stay comparable.
  const COMPLIANCE_SEVERITY_PENALTY = { CATASTROPHIC: 5, CRITICAL: 3, MAJOR: 2, MODERATE: 1, MINOR: 0.5 };
  const compliancePenalty = fixableIssues.reduce(
    (sum, i) => sum + (COMPLIANCE_SEVERITY_PENALTY[String(i.severity).toUpperCase()] ?? 1),
    0
  );
  const score100 = Math.max(0, Math.min(10, 10 - compliancePenalty)) * 10;

  // Issues summary
  let issuesSummary = complianceResult.issues_summary || '';
  if (Array.isArray(issuesSummary)) {
    issuesSummary = issuesSummary.join('. ');
  }

  return {
    score: score100,
    verdict: complianceResult.verdict || 'UNKNOWN',
    // Dimensions this compliance judge could NOT look at. Recording only: it
    // never touches score100 above.
    notEvaluated: notEvaluated.list(),
    issuesSummary,
    fixableIssues,
    // Landmark-guard casualties. Recording only, zero points — see above.
    suppressedIssues,
    visionInventory: visionText,
    complianceResult,
    usage: {
      threeStage_input_tokens: stage1Usage.input_tokens + stage2Usage.input_tokens,
      threeStage_output_tokens: stage1Usage.output_tokens + stage2Usage.output_tokens,
      stage1_input_tokens: stage1Usage.input_tokens,
      stage1_output_tokens: stage1Usage.output_tokens,
      stage2_input_tokens: stage2Usage.input_tokens,
      stage2_output_tokens: stage2Usage.output_tokens
    }
  };
}

/**
 * Evaluate image quality using Gemini API (visual quality + optional semantic fidelity)
 * Sends the image to Gemini for quality assessment, with parallel semantic check when storyText provided
 * @param {string} imageData - Base64 encoded image with data URI prefix
 * @param {string} originalPrompt - The prompt used to generate the image
 * @param {string[]} referenceImages - Reference images used for generation
 * @param {string} evaluationType - Type of evaluation: 'scene' (default) or 'cover' (text-focused)
 * @param {string|null} qualityModelOverride - Override model for quality evaluation
 * @param {string} pageContext - Page context for logging (e.g., "PAGE 5")
 * @param {string|null} storyText - Optional story text for semantic fidelity check (runs in parallel)
 * @param {string|null} sceneHint - Direct statement of what image should show (for semantic eval)
 * @returns {Promise<Object>} Quality result with score, reasoning, semantic issues, etc.
 */

// Unified sanitizer for Gemini safety filters.
// 'light' — strip age numbers, "young boy" → "character", body builds. Keeps standalone "boy"/"girl".
// 'full'  — everything from light PLUS all standalone gender/age nouns → "figure".
function sanitizeForGemini(text, level = 'light') {
  if (!text || typeof text !== 'string') return text;
  let result = text
    // "8-year-old boy" → "character" (light) or "figure" (full) — catch compound first
    .replace(/\b\d+[-\s]?years?[-\s]?old\s+(boy|girl|child|kid|man|woman)\b/gi, level === 'full' ? 'figure' : 'character')
    // Standalone "7-year-old" → ""
    .replace(/\b\d+[-\s]?years?[-\s]?old\b/gi, '')
    // "young boy", "little girl" → "character"/"figure"
    .replace(/\b(young|little|small|tiny)\s+(child|boy|girl|kid|man|woman)\b/gi, level === 'full' ? 'figure' : 'character')
    // "aged 5" → ""
    .replace(/\bage[sd]?\s*\d+\b/gi, '')
    // "slim build" → ""
    .replace(/\b(slim|thin|chubby|petite|small-framed|athletic)\s+(body|build|figure)\b/gi, '');

  if (level === 'full') {
    result = result
      .replace(/\b(boy|girl|child|kid|man|woman|teenager|teen|adult|elderly|toddler|infant|baby)\b/gi, 'figure')
      .replace(/\b(male|female)\s+figure\b/gi, 'figure');
  }

  return result.replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();
}

// Does a Gemini vision response carry nothing usable?
//
// ALLOW-LIST since 2026-09-18 (server/lib/imageReplyGuard.js, the sibling of
// textReplyGuard). This used to test `finishReason === 'SAFETY' ||
// finishReason === 'PROHIBITED_CONTENT'` — an allow-list OF REFUSALS — so
// every other refusal read as a clean response: RECITATION, BLOCKLIST, SPII,
// LANGUAGE, OTHER, NO_IMAGE and the entire IMAGE_* family. Those calls then
// skipped BOTH recovery steps this function gates (the full-sanitisation retry
// and the Grok-vision fallback) and returned null — the page silently lost its
// evaluation instead of getting a second opinion.
//
// MAX_TOKENS is deliberately NOT a block: it is a cut, not a refusal, and it
// has its own retry-with-a-smaller-thinking-budget path below.
const isBlockedResponse = (responseData) => assessImageResponse(responseData).blocked;

/**
 * THE IDENTITY REFERENCE FOR A CHARACTER THE STORY INVENTED (owner, 2026-09-21:
 * "Secondaries have a VB entry and are compared with that").
 *
 * A page's reference list is built from the uploaded roster's avatars and face
 * photos, so a Visual Bible secondary — a character with a VB entry and a
 * rendered reference-sheet cell but no `characters[]` row — reached the judge
 * with no image at all. The judge could then only answer `unmatched` for the
 * figure that is her, the presence derivation dropped the pair as
 * `unclaimed_cast_has_no_reference`, and the defect had no owner.
 * Measured on staging job_1789853503332_riqncqg1i p10/p15: VB CHR001 had a
 * reference-sheet cell and the page eval attached ZERO references for it.
 *
 * The cell IS the reference such a character is drawn from, so it is what she
 * is judged against. It is a DRAWING, not a photograph, and the attach loop
 * labels it as one — an identity reference, never evidence about rendering
 * medium.
 *
 * @param {string[]} castNames    the page's EXPECTED CAST names
 * @param {Object|null} visualBible
 * @param {Object|null} castIndex the resolver index already built for this page
 * @param {Array} existing        references already composed, by name
 * @returns {Array<{name:string, photoUrl:string, vbId:string, vbCell:true}>}
 */
function vbCellReferencesForCast({ castNames = [], visualBible = null, castIndex = null, existing = [] } = {}) {
  if (!visualBible || !Array.isArray(castNames) || castNames.length === 0) return [];
  const { canonicalName, resolveEntity } = getCastResolver();
  const { hasElementReference, elementRefCell } = require('./visualBible');
  const have = new Set(
    (Array.isArray(existing) ? existing : [])
      .map(r => canonicalName(String((typeof r === 'object' && r && r.name) || '')))
      .filter(Boolean)
  );
  const out = [];
  for (const raw of castNames) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const canon = canonicalName(name);
    if (!canon || have.has(canon)) continue;
    const hit = castIndex ? resolveEntity(name, castIndex) : null;
    // Only a VB-authored secondary. A main-cast name resolves to the roster
    // (kind 'cast') and already carries its avatar; an animal is judged by the
    // non-human path, not by figure identity.
    if (!hit || hit.kind !== 'secondary' || !hit.entry) continue;
    if (!hasElementReference(hit.entry)) continue;
    const { cell } = elementRefCell(hit.entry);
    const photoUrl = cell?.referenceImageUrl || cell?.referenceImageData || null;
    if (!photoUrl) continue;
    have.add(canon);
    out.push({ name: hit.name || name, photoUrl, vbId: String(hit.id || ''), vbCell: true });
  }
  return out;
}

/**
 * EXPECTED CAST — the roster the quality evaluator judges figure COUNT against
 * (owner, 2026-09-10). The judge used to receive only ORIGINAL_PROMPT prose and
 * reference photos: on the front cover of job_1788903616404_iqvhj4l8m it saw
 * five children for a four-boy cast, matched the fifth to a name it read in the
 * prose at 0.9, and returned PASS / 100. Nothing in its inputs said "four".
 *
 * Computed in code, injected into the critique, classified by the prompt: the
 * page's photo-backed cast (`sceneCharacters`) plus the Visual Bible secondary
 * characters AND animals the page metadata names — the same helper the
 * char-repair targeting uses (`buildSecondaryExpectedCharacters`), so there is
 * ONE cast builder. Covers add every VB person/animal the cover description
 * names (`matchVbEntitiesInText`, the cover NAME invariant's own matcher). The
 * detector's figure count rides along when the caller has one.
 *
 * Returns { block, names, count } — `block` is '' when no cast is known, and
 * the template then tells the judge not to judge the count at all.
 */
function buildExpectedCastBlock({
  sceneCharacters = null,
  sceneHint = null,
  originalPrompt = '',
  visualBible = null,
  evaluationType = 'scene',
  detectedFigureCount = null,
  pageLabel = '',
  sceneMetadata = null,
  pageNumber = null,
  extraNames = [],
  storyData = null,
  excludedCastNames = null,
} = {}) {
  // RESOLVE. One index for every name question this builder asks.
  const { buildCastIndex, resolveEntity, kindLabel, dedupeByEntity, canonicalName, isNonHuman, flushResolverStats } = getCastResolver();
  const idx = buildCastIndex(storyData, visualBible);
  const names = [];
  const labels = [];
  const seen = new Set();
  // Each roster line says WHAT the entry is. A dog named in the prose is an
  // animal entry; a fifth human child can never satisfy it — which is exactly
  // the substitution the cover evaluator accepted at 0.9 confidence.
  const add = (n, kind = null) => {
    const name = String(n || '').trim();
    if (!name || seen.has(canonicalName(name))) return;
    seen.add(canonicalName(name));
    names.push(name);
    labels.push(kind ? `${name} (${kind})` : name);
  };
  // RESOLVE. Exact name-or-id matching lost the tag on every short-form token
  // ("Rossa" for the Bible's "Kapitänin Rossa"), and an untagged animal is
  // counted as a person by derivePresenceFinding — a false extra_character
  // CRITICAL. The resolver answers the same question for every consumer.
  const vbKind = (nameOrId) => {
    const e = resolveEntity(nameOrId, idx, { pageLabel });
    return e ? kindLabel(e) : null;
  };
  // AN EMPTY CAST IS A NUMBER, NOT A BLANK (2026-09-11). `sceneCharacters: []`
  // is the brief SAYING this frame holds nobody — a creature-only page, a
  // landscape. It used to return an empty block, and an empty EXPECTED CAST
  // tells the evaluator not to judge the figure count at all, so a page written
  // for no people rendered three and no `extra_character` was ever emitted
  // (job_1789147573901_m3uam0nxi p4). `null`/undefined still means UNKNOWN — no
  // roster was supplied — and keeps the blank block.
  const castDeclared = Array.isArray(sceneCharacters);
  for (const c of (castDeclared ? sceneCharacters : [])) add(typeof c === 'string' ? c : c?.name);
  if (!castDeclared) return { block: '', names: [], count: 0, declared: false, population: 'cast_only', crowdExpected: false, nonHumanNames: [] };

  const sh = getStoryHelpers();
  // CROWD FLAG (2026-09-13). Carried on the roster so the presence derivation
  // can skip its surplus branch on a page the brief wrote as populated —
  // arithmetic has no equivalent of the evaluator's N-09. Never inferred from
  // prose: either the brief set the flag or this page has no crowd.
  // POPULATION, THREE STATES (2026-09-19). 'crowd' skips the surplus branch
  // outright, as the boolean always did; 'ambient' lets the arithmetic subtract
  // background-scale figures before comparing. Never inferred from prose: the
  // brief declares it, or the page is read as 'cast_only'.
  let population = 'cast_only';
  let crowdExpected = false;
  try {
    // THE HINT IS NOT ALWAYS THE BRIEF (2026-09-12). The repair pipeline hands
    // the eval `scene.outlineExtract` — the PLAN line — which carries no
    // `---METADATA---` block and therefore no `objects[]`, so every Visual
    // Bible figure filed there vanished from the roster and the page's own
    // secondary character came back as an `extra_character` CRITICAL
    // (job_1789207854566_l43qgl34w p13/p15, a museum conservator the brief
    // cites as CHR001). The parsed metadata is passed in where the caller
    // holds it; parsing a hint stays the fallback.
    const sceneMeta = sceneMetadata || sh.extractSceneMetadata(sceneHint || originalPrompt);
    const { normalisePopulation, resolvePopulation } = require('./sceneMetadata');
    const rawPop = sceneMeta?.population || sceneMeta?.fullData?.population || null;
    const legacyCrowd = sceneMeta?.crowdExpected === true || sceneMeta?.fullData?.crowdExpected === true;
    const declaredPop = normalisePopulation(rawPop, legacyCrowd);
    // THE PLATE IS THE SECOND WITNESS (owner, 2026-09-19). The empty-scene
    // plate is rendered BEFORE any cast is composited, so the people in it
    // belong to the setting by construction — evidence, where the Art
    // Director's `population` is a declaration. Where they disagree the plate
    // wins, and it can only raise the state (bboxDetection.detectPlatePopulation
    // → sceneMetadata.resolvePopulation). A page with no plate keeps the
    // declaration untouched, which is why the genuine uncommissioned-child
    // page still fires.
    const platePop = sceneMeta?.platePopulation || sceneMeta?.fullData?.platePopulation || null;
    const resolved = resolvePopulation(declaredPop, platePop);
    population = resolved.population;
    // LOG THE DISAGREEMENT, so how often the Art Director is wrong about its
    // own setting is a measured number rather than an impression.
    if (resolved.disagreed) {
      log.info(`👥 [PLATE-POP] ${pageLabel || 'page'}: brief declared "${declaredPop}", plate shows "${platePop}" — plate wins`);
    }
    crowdExpected = population === 'crowd';
    for (const e of sh.buildSecondaryExpectedCharacters(visualBible, sceneMeta, [...names], { pageLabel, extraNames, includeAnimals: true })) add(e.name, vbKind(e.name));
    // A SECONDARY THAT DECLARES THIS PAGE IS ON THIS PAGE (2026-09-13). The
    // detector-side roster in storyJobPipeline has always read the VB
    // secondary's own `pages[]` and this one never did — the single input the
    // two rosters could not agree on. Evidence for the rule itself:
    // job_1786743927715_kcx0p939w p3, where the scene metadata named [Emma,
    // Noah] and Lira (pages [3,5,9]) was in the prose and the image prompt.
    // Requires the caller to say which page this is; without it, nothing.
    if (pageNumber !== null && pageNumber !== undefined && Number.isFinite(Number(pageNumber))) {
      // `includeAnimals` (2026-09-19): a named creature the brief stages on this
      // page is EXPECTED CAST, so an absent one is a legitimate finding and a
      // drawn one is not a surplus figure. It reaches the roster the same way a
      // secondary character does — through this one builder, via its own
      // `pages[]` declaration. `nonHumanNames` below (vbNonHumanNames pools
      // `vb.animals`) keeps it out of the people-vs-people arithmetic, and no
      // creature is ever identity-matched against a reference photo it does not
      // have: the photo-backed cast is `sceneCharacters` and nothing else.
      for (const e of sh.buildSecondaryExpectedForPage(visualBible, pageNumber, [...names], { includeAnimals: true })) add(e.name, vbKind(e.name));
    }
    // A FIGURE FILED AS AN OBJECT IS STILL A FIGURE (2026-09-12). The Art
    // Director puts animals and secondary characters in `objects[]` by id, and
    // the cast collector above reads only `characters` / `characterPositions` /
    // `characterClothing` — so `includeAnimals`, added two days earlier, was
    // dead for every animal. On job_1789163494908_kc2joi4ax the grey tomcat was
    // commissioned on pages 12, 15 and 16 as `ANI001` in `objects[]`, never
    // reached this roster, and each page took an `extra_character` CRITICAL for
    // drawing it. Animals and secondaries only — a location or an artifact
    // never joins a cast roster.
    for (const n of require('./sceneMetadata').collectSceneObjectFigureNames(sceneMeta, visualBible)) add(n, vbKind(n));
  } catch { /* a page without parseable metadata keeps its photo-backed cast */ }
  if (evaluationType === 'cover' && visualBible) {
    try {
      const { matchVbEntitiesInText } = require('./coverIterate');
      // THE JUDGE GETS THE GENERATOR'S TRIM (owner, 2026-09-15: "Cover the
      // author is correct max 5"). The cover cast is capped at
      // MAX_COVER_CHARACTERS and every other story character is handed to the
      // model as an explicit exclusion — but the cover PROSE still names them,
      // which is why the restriction block exists at all. Reading the prose
      // back into the roster held the cover to a cast the generator was
      // ordered to violate, and the gap scored CRITICAL. One resolver produces
      // both lists: server/lib/coverCastRoster.js.
      const { MAX_COVER_CHARACTERS } = require('./coverCastRoster');
      const excluded = new Set((Array.isArray(excludedCastNames) ? excludedCastNames : [])
        .map(n => canonicalName(String(n || ''))).filter(Boolean));
      // People count against the cap; an animal the prose names is not a
      // character the cap ever governed.
      let people = names.filter(n => !isNonHuman(resolveEntity(n, idx))).length;
      for (const hit of matchVbEntitiesInText(sceneHint || originalPrompt, visualBible)) {
        if (hit.type !== 'character' && hit.type !== 'animal') continue;
        if (excluded.has(canonicalName(String(hit.name || '')))) continue;
        const before = names.length;
        if (hit.type === 'character') {
          if (people >= MAX_COVER_CHARACTERS) continue;
          add(hit.name, vbKind(hit.name));
          if (names.length > before) people++;
        } else {
          add(hit.name, vbKind(hit.name));
        }
      }
    } catch { /* cover keeps its commissioned cast */ }
  }

  // RESOLVE. A roster never carries two spellings of one entity: the p9 shape
  // of job_1789163494908_kc2joi4ax put "Vendor" and "Marroni Vendor" on the
  // same list, and every downstream count then read one person as two.
  const kept = new Set(dedupeByEntity(names, idx));
  for (let i = names.length - 1; i >= 0; i--) {
    if (kept.has(names[i])) continue;
    names.splice(i, 1);
    labels.splice(i, 1);
  }

  const lines = [names.length === 0
    // Spelled out, not an empty list: the count is the instruction, and "none"
    // has to read as a roster of zero rather than as a missing roster.
    ? 'EXPECTED CAST (0): none — this frame was written with no people and no animals in it'
    : `EXPECTED CAST (${names.length}): ${labels.join(', ')}`];
  // THE JUDGE IS TOLD WHAT THE GENERATOR WAS TOLD (2026-09-19). D-04b/N-09 used
  // to ask the evaluator to work out for itself whether the USER_PROMPT called
  // for a populated setting. The Art Director already decided that, per page —
  // so the decision is handed over rather than guessed at a second time.
  lines.push(population === 'crowd'
    ? 'SETTING POPULATION: crowd — this page is written around unnamed background people; they are not surplus cast.'
    : population === 'ambient'
      ? 'SETTING POPULATION: ambient — this is a public setting and distant background people belong in it. They are not EXPECTED CAST and are never a surplus figure. Only a figure at the same scale as the cast can be one.'
      : 'SETTING POPULATION: cast-only — this page holds the EXPECTED CAST and no other people.');
  const det = Number(detectedFigureCount);
  if (detectedFigureCount !== null && detectedFigureCount !== undefined && Number.isFinite(det)) {
    lines.push(`Detector figure count (GroundingDINO): ${det}`);
  }
  // COUNT PEOPLE AGAINST PEOPLE (owner, 2026-08-18). The roster the EVALUATOR
  // reads keeps everyone — the fairies are on the page and it must account for
  // them. The roster ARITHMETIC reads is people-only, and this is which entries
  // are not. One source with the detector call (`vbNonHumanNames`), never a
  // second guess about what is non-human.
  // RESOLVE, tolerant: the resolver catches the short-form token the exact-name
  // list cannot ("Rossa" for the Bible's "Kapitänin Rossa"), and `vbNonHumanNames`
  // stays the authority for everything it does name.
  const nonHumanSet = new Set(require('./bboxDetection').vbNonHumanNames(visualBible).map(n => canonicalName(n)));
  const nonHumanNames = names.filter(n =>
    nonHumanSet.has(canonicalName(n)) || isNonHuman(resolveEntity(n, idx, { pageLabel })));
  if (pageLabel) flushResolverStats(idx, log, pageLabel);
  return { block: lines.join('\n'), names, count: names.length, declared: true, population, crowdExpected, nonHumanNames };
}

/**
 * ONE ROSTER (2026-09-13). `buildExpectedCastBlock` is authoritative for
 * MEMBERSHIP — who is on this page — and every other cast builder in the
 * pipeline resolves its NAME SET through here.
 *
 * There used to be four builders and they disagreed. On
 * job_1789207854566_l43qgl34w p7 the detector was told to look for
 * Sarah/Saira/Facundo/Fiona while the evaluator judged the same image against
 * Sarah/Facundo/Frau Amrein — three names, four names, zero overlap on two of
 * them, and a CRITICAL `extra_character` out of the gap. The detector-side
 * builders keep producing their own description-bearing entries (the detector
 * needs identity prose this roster does not carry); only the membership
 * question is answered in one place.
 *
 * Returns a lowercase-keyed Map name → canonical spelling, plus the ordered
 * `names` array, so a caller can both test membership and append what it lacks.
 */
function resolveExpectedCastNames(opts = {}) {
  const cast = buildExpectedCastBlock(opts);
  // COMPARE. Still a lowercase-keyed Map — keyed through `canonicalName` so
  // every membership test in the pipeline normalises the same way.
  const { canonicalName } = getCastResolver();
  const byLower = new Map();
  for (const n of cast.names) byLower.set(canonicalName(n), n);
  return { names: cast.names, byLower, declared: cast.declared };
}

/**
 * Bring a detector-side cast list onto the authoritative roster.
 *
 * The detector's entries carry identity PROSE the eval roster does not have
 * ("silver hair in a tight bun, rectangular reading glasses") and that prose is
 * what lets Set-of-Mark tell two figures apart — so those entries are never
 * rewritten or dropped here. What is reconciled is MEMBERSHIP: any name the
 * authoritative roster holds and this list lacks is appended, described from
 * the Visual Bible when the Bible knows it and name-only when it does not.
 *
 * "Lacks" is ENTITY-EQUAL, not case-insensitive string equality: a detector
 * entry and a roster name that resolve to the same Visual Bible entry are the
 * same person however each of them spells it.
 *
 * Appending only. A detector list is allowed to be richer than the roster in
 * one direction (a VB secondary resolved by a path the roster has not been
 * given yet); deleting from it on that basis would blind the identity call —
 * measured on job_1789207854566_l43qgl34w p15, where the detector's six names
 * were correct and the page roster's `[Fiona]` was the stale one.
 *
 * @returns {{entries: Array, names: Array<string>, added: Array<string>}}
 */
function reconcileDetectorCast(entries, authoritative, { visualBible = null, pageLabel = '', storyData = null } = {}) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const auth = authoritative && authoritative.byLower instanceof Map ? authoritative : null;
  if (!auth || auth.names.length === 0) {
    return { entries: list, names: list.map(e => e?.name).filter(Boolean), added: [] };
  }
  // RESOLVE. `have` used to hold the DETECTOR spellings lowercased and
  // `missing` compared the ROSTER names to it by string, so a short form and a
  // long form of one person never met and the same person was appended twice —
  // job_1789163494908_kc2joi4ax p9 stored ["Julian","Max","Kiaan","Vendor",
  // "Marroni Vendor"]. Membership is an ENTITY question, asked of the resolver.
  const { buildCastIndex, sameEntity, canonicalName } = getCastResolver();
  const idx = buildCastIndex(storyData, visualBible);
  const have = new Set(list.map(e => canonicalName(String(e?.name || ''))).filter(Boolean));
  const missing = auth.names.filter(n => !list.some(e => sameEntity(e?.name, n, idx)));
  const added = [];
  if (missing.length > 0) {
    let described = {};
    try {
      described = getStoryHelpers().buildSecondaryCharacterDescriptions(
        visualBible, missing, [...have], pageLabel, { includeAnimals: true }) || {};
    } catch { /* a roster name the Bible cannot describe still joins, name-only */ }
    for (const n of missing) {
      // COMPARE: two spellings produced by this same run.
      const hit = Object.keys(described).find(k => canonicalName(k) === canonicalName(n));
      list.push({ name: hit || n, description: hit ? (described[hit].richDescription || '') : '' });
      added.push(hit || n);
    }
    log.debug(`👥 [ONE ROSTER] ${pageLabel}detector cast gained ${added.length} roster name(s): ${added.join(', ')}`);
  }
  return { entries: list, names: list.map(e => e?.name).filter(Boolean), added };
}

/**
 * The evaluator's `fixable_issues[]` in the pipeline's finding shape. Pure —
 * split out so the parse+score path can be exercised without a model call.
 */
function parseFixableIssues(parsedJson) {
  if (!parsedJson || !Array.isArray(parsedJson.fixable_issues)) return [];
  return parsedJson.fixable_issues
    .filter(i => i && i.description)
    .map(i => ({
      description: i.description,
      severity: i.severity || 'MODERATE',
      type: i.type || 'default',
      character: i.character || null,  // Preserved for bbox matching (incl. STEP 2C proportion issues)
      fix: i.fix || `Fix: ${i.description}`,
      // See the compliance mapper: a stand-in `fix` is not an edit instruction,
      // and the landmark guard must not read one as though it were.
      ...(i.fix ? {} : { fixAuthored: false }),
      // The quality judge's declared landmark subject, passed through when it
      // answered; absent stays absent, which the guard reads as UNDECLARED.
      ...(i.landmark_element === undefined ? {} : { landmark_element: i.landmark_element }),
    }));
}

/** Stamped on every finding this file's arithmetic authored (see derivePresenceFinding). */
const PRESENCE_DERIVED_MARKER = 'presence-arithmetic';

/** The presence types the derivation owns outright once it has spoken. */
const PRESENCE_COUNT_TYPES = new Set(['missing_character', 'extra_character']);

/**
 * Drop the compliance judge's presence findings from the RECORD once the
 * arithmetic has spoken (2026-09-14).
 *
 * The merge used to filter a local copy on its way into the page's merged
 * `fixableIssues`, and the finding lived on untouched inside `threeStageResult`
 * — which is the object `scoring.js` reads for the compliance bucket
 * (`evalResult.threeStageResult.fixableIssues`) and again for
 * `scoreBreakdown.threeStage.issues`. From there it reached
 * `consolidatedPlan.deduped_issues` and the repair pipeline, so a finding the
 * derivation had superseded was still repaired against. Both lists — the mapped
 * one and the judge's own `complianceResult.fixable_issues` — are pruned here.
 *
 * Mutates in place, by design: the stored record and the merged list must be
 * the same answer. Returns how many entries went.
 */
function supersedePresenceFindings(threeStageResult) {
  if (!threeStageResult || typeof threeStageResult !== 'object') return 0;
  const isPresenceType = (t) => PRESENCE_COUNT_TYPES.has(String(t || '').toLowerCase());
  let dropped = 0;
  if (Array.isArray(threeStageResult.fixableIssues)) {
    const before = threeStageResult.fixableIssues.length;
    threeStageResult.fixableIssues = threeStageResult.fixableIssues.filter(i => !isPresenceType(i?.type));
    dropped = before - threeStageResult.fixableIssues.length;
  }
  if (Array.isArray(threeStageResult.complianceResult?.fixable_issues)) {
    threeStageResult.complianceResult.fixable_issues =
      threeStageResult.complianceResult.fixable_issues.filter(i => !isPresenceType(i?.type));
  }
  return dropped;
}

/**
 * THE PRESENCE SIGNAL (owner, 2026-09-13). One page, one outcome, mutually
 * exclusive by construction.
 *
 * Four layers used to argue about "is this figure really extra?" — D-04, D-04b
 * and D-04c in the evaluator prompt, an exception clause in the consolidator,
 * two log-only diagnostics here, and a two-witness absence filter in
 * identityAgreement. They disagreed, and their disagreement was destructive:
 * an `extra_character` routed to inpaint erased a commissioned child from a
 * cover, while the same page also carried a `missing_character` for the child
 * it had just erased.
 *
 * The evaluator keeps the job it can do — OBSERVATION. It reports `figures[]`
 * and `matches[]`, one match per figure, same ids and order. This function does
 * the arithmetic, which is mechanical: a count and a list the model declared.
 * No prose is read; no finding's description is interpreted.
 *
 *   figures <  cast                      -> missing_character
 *   figures >  cast                      -> extra_character  (unless the brief declared a crowd)
 *   figures == cast, an unmatched figure -> character_identity, naming who it should be
 *   figures == cast, all matched         -> nothing
 *
 * And four reasons to say nothing at all rather than guess:
 *   - the roster was never declared (`declared: false`) — no cast, no arithmetic;
 *   - no detector count reached this call (~4 sites genuinely cannot supply one);
 *   - `matches[]` is not the per-figure list its contract promises;
 *   - THE WITNESSES DISAGREE. The detector's real-figure count and the
 *     evaluator's own enumeration are two independent readings of the same
 *     picture; when they differ, the count is not trustworthy for this page and
 *     nothing is derived. This is the two-witness rule (owner, 2026-08-27),
 *     folded in from identityAgreement — it used to run afterwards, deleting
 *     absence claims one at a time; here it gates the claim being made at all.
 *
 * Pure. Never mutates its inputs.
 *
 * @param {object} args
 * @param {Array} args.figures - the evaluator's `figures[]`
 * @param {Array} args.matches - the evaluator's `matches[]`, one per figure
 * @param {{names: string[], count: number, declared: boolean, population: string, crowdExpected: boolean,
 *          nonHumanNames: string[]}} args.cast
 *        the roster from buildExpectedCastBlock. `nonHumanNames` are the entries
 *        a "person" detector can never satisfy (the VB's `animals` pool);
 *        every count below is taken with those removed from BOTH sides.
 * @param {Array|null} args.detectorFigures - the detector's own figures, with boxes.
 *        Read ONLY on a page the brief declared `population: "ambient"`, to drop
 *        background-scale figures from the surplus comparison by geometry. Absent,
 *        an ambient page declines rather than guessing.
 * @param {number|null} args.detectedFigureCount - countRealFigures(detector figures),
 *        with the figures the detector itself named as non-human removed — a
 *        PEOPLE count, because that is what the derivation compares against
 * @param {string[]|null} args.referenceNames - the names the evaluator was actually
 *        HANDED a labelled `Reference: <name>` image for on this call. An array
 *        (empty included) gates the identity branch; `undefined` means the caller
 *        could not say, and the branch behaves as before.
 * @returns {{outcome: string, reason: string|null, finding: object|null}}
 */
/**
 * The runMetrics counter name for one presence derivation.
 *
 * `spoke` is true when the arithmetic actually decided (outcome + optional
 * reason); false when it DECLINED, which is the interesting case — it is how
 * often the detector and the evaluator disagree badly enough that presence
 * refuses to rule. Kept here, next to the derivation, so the counter vocabulary
 * and the derivation cannot drift apart, and so it is testable without an
 * evaluator call.
 */
function presenceCounterName(presence, spoke) {
  const reason = presence?.reason ? `_${presence.reason}` : '';
  return spoke ? `presence_${presence?.outcome}${reason}` : `presence_declined${reason}`;
}

function derivePresenceFinding({ figures, matches, cast, detectedFigureCount, detectorFigures = null, referenceNames, castIndex = null } = {}) {
  // RESOLVE (castIndex, when the caller has one) + COMPARE (everything else:
  // both sides of every name test below are strings this same run produced).
  const { canonicalName, resolveEntity, isNonHuman } = getCastResolver();
  const decline = (reason) => ({ outcome: 'declined', reason, finding: null });

  if (!cast || cast.declared !== true) return decline('roster_not_declared');
  const det = Number(detectedFigureCount);
  if (detectedFigureCount === null || detectedFigureCount === undefined || !Number.isFinite(det)) {
    return decline('no_detector_count');
  }
  const figs = Array.isArray(figures) ? figures : null;
  const mts = Array.isArray(matches) ? matches : null;
  // `matches` carries exactly one entry per figure, same ids and order
  // (image-evaluation D — OUTPUT). A reply that broke that contract has no
  // second witness, so there is nothing to reconcile against.
  if (!figs || !mts || figs.length !== mts.length) return decline('matches_contract_broken');
  // COUNT PEOPLE AGAINST PEOPLE (owner, 2026-08-18; applied at this layer
  // 2026-09-13). The detector's prompt is "person", so its count is a count of
  // PEOPLE. Comparing it to a roster that holds the story's dog, dragon or
  // fairies makes every such page report a shortfall; `figureDetection` learned
  // that in August and this derivation, one layer up, repeated it in both
  // directions at once. Measured on job_1789304198359_y3n0euk3z (four fairies
  // in `visualBible.animals`): 4 of 23 page-versions declined
  // `witnesses_disagree`, every one a fairy page, the evaluator counting the
  // fairies and the detector not.
  //
  // So both sides are reduced to people before anything is compared. The
  // evaluator's side needs it too: it DOES see the fairies, so `figures.length`
  // is an everything-count. Only a figure it NAMED as a non-human roster entry
  // can be subtracted — a figure it left `unmatched` is of unknown kind and
  // stays counted, which keeps the disagreement honest rather than explaining
  // it away.
  //
  // There is deliberately no non-human presence check to replace this: a
  // missing fairy simply stops being arithmetic evidence (owner).
  const nonHumanSet = new Set((Array.isArray(cast.nonHumanNames) ? cast.nonHumanNames : [])
    .map(n => canonicalName(n)).filter(Boolean));
  // Tolerant: the roster's own list first, then the resolver for a short-form
  // token the list spells out in full. Without an index the canonical match is
  // the whole answer, exactly as before.
  const isNonHumanName = (n) => {
    const k = canonicalName(n);
    if (!k) return false;
    if (nonHumanSet.has(k)) return true;
    return castIndex ? isNonHuman(resolveEntity(n, castIndex)) : false;
  };
  const refOf = (m) => canonicalName(m?.reference || '');
  const isUnnamed = (r) => !r || r === 'unmatched' || r === 'unknown';
  const evaluatorPeople = figs.length - mts.filter(m => isNonHumanName(m?.reference)).length;
  if (det !== evaluatorPeople) return decline('witnesses_disagree');

  const castNames = (Array.isArray(cast.names) ? cast.names : [])
    .filter(n => !isNonHumanName(n));
  const castCount = castNames.length;
  // Who did the evaluator place in the picture? Names only, lowercased.
  const claimed = new Set();
  for (const m of mts) {
    const r = refOf(m);
    if (!isUnnamed(r)) claimed.add(r);
  }
  const unclaimedCast = castNames.filter(n => !claimed.has(canonicalName(n)));
  const unmatchedFigures = mts.filter(m => isUnnamed(refOf(m)));

  // PROVENANCE (2026-09-14). This finding is authored by THIS FILE's arithmetic,
  // not by the quality judge whose list it joins — `final_checks` is the
  // vocabulary's entry for a code-authored mechanical check. Stamped here so the
  // quality stamp at the merge chokepoint, which never overwrites, leaves it be;
  // without it the derivation would read back as a judge's opinion.
  const mark = (finding) => ({ ...finding, severity: 'CRITICAL', derivedBy: PRESENCE_DERIVED_MARKER, sources: [FINDING_SOURCES.FINAL_CHECKS] });

  if (det < castCount) {
    const who = unclaimedCast[0] || null;
    return {
      outcome: 'missing_character',
      reason: null,
      finding: mark({
        type: 'missing_character',
        // `character` for every per-figure reader; `item` because the inpaint
        // reference attach reads `missing.item` to find the VB cell to show.
        character: who,
        item: who,
        description: `${det} person-figure(s) are in the frame for an EXPECTED CAST of ${castCount} person(s)`
          + (who ? `; ${who} is absent.` : '.'),
        fix: who
          ? `Add ${who} to the scene, matching that entry's reference and CLOTHING CONTRACT.`
          : `Add the missing EXPECTED CAST member, matching that entry's reference and CLOTHING CONTRACT.`,
      }),
    };
  }

  if (det > castCount) {
    // N-09 in arithmetic form. A page the brief wrote as populated has unnamed
    // background people on purpose; the surplus is the crowd, not a defect.
    if (cast.population === 'crowd' || cast.crowdExpected === true) return decline('crowd_expected');
    // AMBIENT IS NOT A CROWD, AND IT IS NOT CAST EITHER (2026-09-19). On a page
    // the Art Director declared `population: "ambient"` — a square, a park, a
    // quay — distant background people belong in the frame. They are dropped
    // from the count by SCALE (bboxDetection.countAmbientFigures: geometry
    // only, never a label or a description), and whatever surplus remains is
    // still a real surplus. That is what keeps the uncommissioned cast-scale
    // figure catchable: job_1789420511893_zly5rcdej p16's fourth child is 1.8x
    // the smallest genuine cast figure and survives the filter.
    //
    // Without the detector's figures there is no geometry to measure, so the
    // page is treated like a crowd page and nothing is derived — a declined
    // outcome, never a CRITICAL guessed at. The evaluator's own D-04b still
    // stands there, reading the same SETTING POPULATION line.
    let ambientDropped = 0;
    if (cast.population === 'ambient') {
      const bbox = require('./bboxDetection');
      // GEOMETRY, NOT JUST AN ARRAY. The detector's VLM fallback returns figures
      // with a label and no box; measuring size over those is blind, not
      // conservative, so the page declines rather than billing a CRITICAL the
      // filter never had a chance to clear.
      if (!bbox.hasAmbientGeometry(detectorFigures)) return decline('ambient_without_geometry');
      ambientDropped = bbox.countAmbientFigures(detectorFigures);
      if (det - ambientDropped <= castCount) return decline('ambient_background');
    }
    const fig = unmatchedFigures[0];
    const figId = fig && (fig.figure ?? fig.id);
    return {
      outcome: 'extra_character',
      reason: null,
      finding: mark({
        type: 'extra_character',
        character: figId !== undefined && figId !== null ? `figure ${figId}` : null,
        // On a cast-only page this is the sentence it has always been. Only an
        // ambient page, where background life was subtracted, says so.
        description: `${det - ambientDropped}${ambientDropped ? ' cast-scale' : ''} person-figure(s) are in the frame for an EXPECTED CAST of ${castCount} person(s)`
          + ` — ${det - ambientDropped - castCount} more figure(s) than the page was written to hold.`
          + (ambientDropped ? ` (${ambientDropped} distant background figure(s) belong to the setting and were not counted.)` : ''),
        fix: "Redraw this figure as the EXPECTED CAST entry it should be, matching that entry's reference and CLOTHING CONTRACT.",
      }),
    };
  }

  // Counts reconcile. An unmatched figure alongside an unclaimed cast name is
  // ONE recognition failure, not an absence plus a surplus — the old D-04c,
  // now arithmetic.
  if (unmatchedFigures.length === 0) return { outcome: 'reconciled', reason: null, finding: null };

  // UNMATCHED IS ONLY EVIDENCE WHEN THERE WAS SOMETHING TO MATCH AGAINST
  // (2026-09-13). `matches[]` is produced by comparing each figure to the
  // labelled `Reference: <name>` images attached to the critique — the page's
  // photo-backed cast. A Visual Bible secondary joins this roster from the
  // brief and used to carry NO such image, so the only answer the evaluator
  // could give for the figure that is her was `unmatched`, whether she was
  // drawn right or wrong. Since 2026-09-21 a secondary WITH a rendered
  // reference-sheet cell is handed that cell (vbCellReferencesForCast), so she
  // is reference-backed and her name IS claimable here; what remains below is
  // the cast entry that reached the judge with no image of any kind. Billing a CRITICAL on that is a false positive by construction:
  // job_1789207854566_l43qgl34w p3 (one figure, roster [Frau Amrein], zero
  // references attached) and p4/p13 (roster [Fiona, Frau Amrein], Fiona
  // matched, the second figure unmatched because she is the secondary).
  //
  // So the branch needs a reference-backed cast entry to name. Not a decline:
  // the counts DID reconcile, which is a real outcome — the derivation still
  // owns the pair and still drops the evaluator's arithmetically impossible
  // surplus on those pages. It just has no identity claim to make.
  const refs = Array.isArray(referenceNames)
    ? new Set(referenceNames.map(n => canonicalName(n || '')).filter(Boolean))
    : null;
  const referenced = refs ? unclaimedCast.filter(n => refs.has(canonicalName(n))) : unclaimedCast;
  // At equal counts an unmatched figure always leaves a cast name unclaimed
  // (distinct claims <= figures - unmatched < castCount), so this is exactly
  // the question "is the entry it should be one the evaluator had an image of".
  // A page that got no reference at all (`refs.size === 0`) is the same answer.
  if (refs && referenced.length === 0) {
    return { outcome: 'reconciled', reason: 'unclaimed_cast_has_no_reference', finding: null };
  }

  const fig = unmatchedFigures[0];
  const figId = fig && (fig.figure ?? fig.id);
  const who = referenced[0] || null;
  const figLabel = figId !== undefined && figId !== null ? `figure ${figId}` : 'the unmatched figure';
  return {
    outcome: 'character_identity',
    reason: null,
    finding: mark({
      type: 'character_identity',
      // The cast member is what a repair has to paint; the figure is named in
      // the description so the target is unambiguous either way.
      character: who || (figId !== undefined && figId !== null ? `figure ${figId}` : null),
      description: `${figLabel} matches no EXPECTED CAST entry while the frame holds exactly the cast (${castCount})`
        + (who ? `; it should be ${who}.` : '.'),
      fix: who
        ? `Redraw ${figLabel} as ${who}, matching that entry's reference and CLOTHING CONTRACT.`
        : `Redraw ${figLabel} as the EXPECTED CAST entry it should be, matching that entry's reference and CLOTHING CONTRACT.`,
    }),
  };
}

/**
 * THE CLOTHING CONTRACT every evaluator is handed — one builder.
 *
 * Extracted verbatim from evaluateImageQuality (2026-09-14) so the Test Lab's
 * standalone `semantic_eval` stage can pass the SAME block production's
 * semantic judge gets. Production builds it once and hands it to the quality,
 * semantic and compliance judges alike; the Lab stage called
 * evaluateSemanticFidelity with no options at all, so its judge ran with no
 * contract, no art style and no cast roster and its verdicts were never
 * comparable to production's.
 *
 * Two sources, one block. The reference photos already carry the resolved
 * per-page outfit (`clothingDescription`, set by the prompt builder) and that
 * is what every call site has in scope; `clothingRequirements` is the explicit
 * override for callers that resolved it themselves.
 *
 * @returns {{block: string, error: string|null}} `block` empty means no
 *          contract could be built — the caller decides how loudly to say so.
 */
/**
 * REQUIRED OBJECTS as its own evaluator input (2026-09-14).
 *
 * Third member of the ART_STYLE / CLOTHING_CONTRACT family, and it exists for
 * the identical reason: the batch evaluator's ORIGINAL_PROMPT is the scene
 * DESCRIPTION, never the built prompt (`resolveEvalSceneDescription` keeps it
 * that way so `resolveEvalArtStyle`'s "no **ART STYLE block" invariant holds),
 * and the REQUIRED OBJECTS checklist is emitted into that same prompt tail. A
 * rule reading the checklist out of ORIGINAL_PROMPT therefore never fires on
 * the production path — which is what happened to D-16b (the held-object swap)
 * from the day it was written.
 *
 * Two sources, in fidelity order:
 *  1. the page's BUILT prompt — `parseVisualBibleObjects` returns the exact
 *     bold leads the checklist emitted (locations already excluded);
 *  2. the parsed scene metadata's `objects[]`, which in stored data is VB ids
 *     ("ART001", "ANI001", "LOC001") — resolved through the same
 *     `elementLeadLabel` the checklist uses, with locations dropped to match.
 *
 * @returns {{block: string, source: string|null}} `block` empty means nothing
 *          could be resolved; the template then tells the judge to skip.
 */
function buildEvalRequiredObjects({ pagePrompt = null, sceneMetadata = null, visualBible = null, language = 'en' } = {}) {
  const dedupe = (names) => {
    const seen = new Set();
    const out = [];
    for (const n of names) {
      const s = String(n || '').trim();
      if (!s) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out;
  };
  try {
    const { parseVisualBibleObjects, resolveExpectedObjectLabels } = require('./bboxDetection');
    if (pagePrompt && typeof pagePrompt === 'string') {
      const fromPrompt = dedupe(parseVisualBibleObjects(pagePrompt));
      if (fromPrompt.length) return { block: fromPrompt.join(', '), source: 'prompt' };
    }
    const ids = Array.isArray(sceneMetadata?.objects) ? sceneMetadata.objects : [];
    if (!ids.length) return { block: '', source: null };
    // Locations are not props: the checklist skips them and so does the
    // prompt parser, so the fallback must too or the judge is handed a place
    // name as something a hand could be holding.
    const isLocationId = (raw) => /^LOC\d{3}(?:\.\d+)?$/i.test(String(raw || '').trim());
    const labels = dedupe(resolveExpectedObjectLabels(ids.filter(id => !isLocationId(id)), visualBible, language));
    return labels.length ? { block: labels.join(', '), source: 'sceneMetadata' } : { block: '', source: null };
  } catch {
    return { block: '', source: null };
  }
}

function buildEvalClothingContract({
  sceneCharacters = null,
  referenceImages = null,
  artStyle = null,
  visualBible = null,
  clothingRequirements = null,
  sceneMetadata = null,
  sceneHint = null,
  originalPrompt = null,
} = {}) {
  try {
    const lines = [];
    // WORN ITEMS. A page can declare a garment OFF (`wornItems[]`), and the
    // generator honours it — the judge must be handed the SAME stripped
    // outfit or it scores the render against a garment the brief removed and
    // orders a paid repair round to repaint it. One resolver, shared with the
    // generator's own strip. See wornItems.resolveGeneratedOutfit — which
    // returns the outfit UNCHANGED when `visualBible` is falsy, so a caller
    // that omits the bible gets the unstripped story-level outfit and no
    // warning whatsoever.
    const { resolveGeneratedOutfit } = require('./wornItems');
    const wornMeta = sceneMetadata
      || (() => { try { return getStoryHelpers().extractSceneMetadata(sceneHint || originalPrompt); } catch { return null; } })();
    const wornCtx = { visualBible: visualBible || null, sceneMetadata: wornMeta };
    const asWorn = (name, outfit) => resolveGeneratedOutfit(outfit, name, wornCtx);
    const reqs = clothingRequirements || null;
    if (reqs) {
      const { buildClothingDescription } = require('./entityConsistency');
      for (const c of (sceneCharacters || [])) {
        if (!c?.name) continue;
        const category = reqs[c.name]?._currentClothing;
        if (!category) continue;
        const outfit = asWorn(c.name, buildClothingDescription(c, category, artStyle, reqs));
        if (outfit && String(outfit).trim()) lines.push(`- ${c.name}: ${String(outfit).trim()}`);
      }
    }
    if (lines.length === 0) {
      for (const p of (referenceImages || [])) {
        if (!p?.name || !p?.clothingDescription) continue;
        const outfit = asWorn(p.name, p.clothingDescription);
        if (outfit && String(outfit).trim()) lines.push(`- ${p.name}: ${String(outfit).trim()}`);
      }
    }
    return { block: lines.join('\n'), error: null };
  } catch (err) {
    return { block: '', error: err.message };
  }
}

async function evaluateImageQuality(imageData, originalPrompt = '', referenceImages = [], evaluationType = 'scene', qualityModelOverride = null, pageContext = '', storyText = null, sceneHint = null, sceneCharacters = null, evalOptions = {}) {
  // evalOptions.evalTemplateOverride / .semanticTemplateOverride: Test Lab A/B
  // variants — full replacement template strings used instead of the loaded
  // files for THIS call only (PROMPT_TEMPLATES is never mutated).
  // Hoisted outside try so the catch/finally below can reference them.
  // `let` is block-scoped to the try body — without these declarations here,
  // the finally's `if (qualityFiguresResolve)` throws ReferenceError on every
  // call, taking down all 10 page evaluations + cover gen with it.
  let semanticPromise = null;
  let threeStagePromise = null;
  let qualityFiguresPromise = null;
  let qualityFiguresResolve = null;
  let p1Promise = null;
  // NOT-EVALUATED RECORD (2026-09-14). Silence from a check that ran clean and
  // silence from a check that could not run used to be the same signal; this
  // makes the second one a field on the result. Recording only — no entry here
  // is ever a deduction, a severity, or a repair trigger. See notEvaluated.js.
  const notEvaluated = require('./notEvaluated').createNotEvaluatedRecorder({ pageContext });
  try {
    // Guard against undefined/invalid imageData
    if (!imageData || typeof imageData !== 'string') {
      log.warn(`⚠️ [QUALITY] Invalid imageData passed to evaluateImageQuality: ${typeof imageData}`);
      return null;
    }

    // Strip scene description to relevant parts (remove Art Director checks, corrections, preview mismatches)
    // This reduces prompt size significantly and focuses the model on actual scene content
    // GATE ON THE DELIMITER, not on two field names that happen to appear in
    // one metadata dialect. A brief whose METADATA block carried neither
    // "previewMismatches" nor "checks" skipped the strip entirely and shipped
    // the whole JSON — `objects: ["LOC006","ART001",...]` included — into the
    // evaluator prompt.
    if (originalPrompt && (originalPrompt.includes('---METADATA---')
        || originalPrompt.includes('"previewMismatches"') || originalPrompt.includes('"checks"'))) {
      const { stripSceneMetadata } = getStoryHelpers();
      const stripped = stripSceneMetadata(originalPrompt);
      if (stripped && stripped !== originalPrompt) {
        log.debug(`✂️ [QUALITY] ${pageContext} Stripped scene description: ${originalPrompt.length} → ${stripped.length} chars`);
        originalPrompt = stripped;
      }
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      log.verbose('⚠️  [QUALITY] Gemini API key not configured, skipping quality evaluation');
      return null;
    }

    // Covers get the SAME fidelity checks as pages (semantic, three-stage,
    // visual inventory) — they are not exempt. A page's reference is its story
    // prose; a cover has none, so its reference is the cover brief, which
    // arrives as sceneHint (scene.outlineExtract). Comparing the cover against
    // its own brief catches wrong placement ("characters standing in the
    // river"), wrong/extra objects, and missing figures. The title/dedication
    // text is the only cover-specific concern, handled by the TEXT RULES below.
    const isCover = evaluationType === 'cover';
    // Covers are head-on portraits: viewer-gaze and a flat 2D title are correct,
    // not defects. Tell the fidelity evaluators so they don't penalize those,
    // while still catching placement / text / identity problems.
    const coverEvalNote = '\n\nCOVER: a book-cover portrait. Characters facing or looking at the viewer is intended — do not deduct for gaze direction or for facing the camera. A flat 2D title is acceptable — do not deduct for the title not being three-dimensional. Still flag implausible placement (a figure on a surface that cannot support it), wrong or garbled text on objects, and missing, extra, or mismatched characters.';
    // A cover has no story prose, so its fidelity reference is the raw cover
    // brief — metadata block, VB ids and all. Pages get theirs stripped above;
    // this branch never did.
    const fidelityRef = storyText || (isCover && sceneHint
      ? require('./vbIdGuard').scrubVbIds(
          getStoryHelpers().stripSceneMetadata(sceneHint) || sceneHint,
          evalOptions.visualBible || null) + coverEvalNote
      : null);
    const runFidelity = !!fidelityRef && (evaluationType === 'scene' || isCover);

    // Art style + clothing contract are inputs to EVERY evaluator (quality,
    // semantic, compliance) — built once, up front, before the parallel evals
    // start. A contract that only some evaluators see is how a steampunk
    // cover's commissioned costume got repair-stripped as "unrequested attire".
    // evalOptions.artStyle lets a caller supply the style when originalPrompt is
    // not the full page prompt (Test Lab passes the scene description).
    const artStyleForEval = evalOptions.artStyle
      || require('../services/prompts').extractArtStyle(originalPrompt);
    // Two sources, one block. The reference photos already carry the resolved
    // per-page outfit (`clothingDescription`, set by the prompt builder) and
    // that is what every call site has in scope; evalOptions.clothingRequirements
    // is the explicit override for callers that resolved it themselves.
    const contract = buildEvalClothingContract({
      sceneCharacters,
      referenceImages,
      artStyle: artStyleForEval,
      visualBible: evalOptions.visualBible || null,
      clothingRequirements: evalOptions.clothingRequirements || null,
      sceneMetadata: evalOptions.sceneMetadata || null,
      sceneHint,
      originalPrompt,
    });
    const clothingContractBlock = contract.block;
    // LANDMARK CONTEXT — the fourth block in this family, and for the same
    // reason (2026-09-18). It reached the compliance judge ALONE, so the
    // semantic and quality judges were never told this page depicts a real
    // place and kept proposing that the real place be painted out; the one
    // production landmark fire on record came from the semantic judge. ONE
    // builder for all three (landmarkProtection.buildLandmarkContextBlock) —
    // never a second hand-written copy of the wording.
    const landmarkProtection = require('./landmarkProtection')
      .computeLandmarkProtection({ landmarkPhotos: evalOptions.landmarkPhotos || null, era: evalOptions.era || null });
    const landmarkContextBlock = require('./landmarkProtection').buildLandmarkContextBlock(landmarkProtection);
    if (contract.error) {
      log.debug(`[EVAL] clothing contract block skipped: ${contract.error}`);
      notEvaluated.record('clothing', 'clothing_contract_build_failed', contract.error);
    } else if (!clothingContractBlock && (evaluationType === 'scene' || evaluationType === 'cover')) {
      // Loud, because an empty contract is what let the judge invent one.
      // Covers included: the 'scene'-only gate hid exactly the cover case
      // where an empty contract let the judge strip a requested costume.
      log.warn(`👕 [EVAL] ${pageContext || 'page'}: no clothing contract available — clothing findings suppressed (N-16)`);
      // The log line above existed and did not help: the eval went on to
      // return a normal score with nothing saying clothing went unjudged.
      notEvaluated.record('clothing', 'no_clothing_contract',
        'No per-character outfit block could be built - clothing findings are suppressed (N-16)');
    }

    // REQUIRED OBJECTS, same family as the two blocks above and for the same
    // reason (see buildEvalRequiredObjects). Empty is the honest default:
    // D-16b skips rather than inventing a checklist.
    const requiredObjects = buildEvalRequiredObjects({
      pagePrompt: evalOptions.pagePrompt || null,
      sceneMetadata: evalOptions.sceneMetadata || null,
      visualBible: evalOptions.visualBible || null,
      // The label must match the lead the page prompt actually emitted, which
      // is language-dependent (elementLeadLabel).
      language: evalOptions.language || evalOptions.storyMeta?.language || 'en',
    });
    const requiredObjectsBlock = requiredObjects.block;
    // REQUIRED TEXT allow-list (2026-09-21), fourth member of the
    // ART_STYLE / CLOTHING_CONTRACT / REQUIRED_OBJECTS family and built for the
    // same reason: the page's declared in-image strings are not readable out of
    // ORIGINAL_PROMPT on every path. ONE builder for all three judges
    // (requiredText.js), exactly like buildLandmarkContextBlock. Empty when the
    // page declares none, which is the honest default -- the templates then
    // apply the plain no-lettering rule unchanged.
    let requiredTextBlock = '';
    try {
      const requiredTextLib = require('./requiredText');
      const ids = Array.isArray(evalOptions.sceneMetadata?.objects) ? evalOptions.sceneMetadata.objects : [];
      requiredTextBlock = requiredTextLib.buildRequiredTextRulesBlock(
        requiredTextLib.collectRequiredTexts({
          objectIds: ids,
          visualBible: evalOptions.visualBible || null,
          language: evalOptions.language || evalOptions.storyMeta?.language || 'en',
        })
      );
    } catch (err) {
      // Loud, and recorded on the result: a page whose declared string could
      // not be resolved was NOT judged for it -- never silently clean.
      log.error(`[EVAL] ${pageContext || 'page'}: required-text rules could not be built - ${err.message}`);
      notEvaluated.record('required_text', 'required_text_build_failed', err.message);
    }
    if (!requiredObjectsBlock && (evaluationType === 'scene' || evaluationType === 'cover')) {
      notEvaluated.record('held_objects', 'no_required_objects',
        'No REQUIRED OBJECTS list could be resolved - held-object swaps (D-16b) were not judged');
    }

    // EXPECTED CAST roster + count (see buildExpectedCastBlock). Built once,
    // read by the quality prompt, the semantic judge, the compliance judge and
    // the post-parse count diagnostic. ONE ROSTER means all four, so this block
    // sits ABOVE the semantic launch below — nothing between here and the two
    // parallel eval launches may move above it.
    // COUNT ONLY REAL FIGURES. A caller that hands over the figures array
    // gets them filtered here (see isMicroFigure); a caller that only has a
    // number is trusted to have filtered already — images.js does. Hoisted:
    // the prompt hint and the presence derivation read the SAME number.
    const realFigureCount = Array.isArray(evalOptions.detectedFigures)
      ? require('./bboxDetection').countRealFigures(evalOptions.detectedFigures)
      : (evalOptions.detectedFigureCount ?? null);
    // ...AND THE SAME COUNT WITH THE NON-HUMANS TAKEN OUT. The detector's
    // prompt is "person", but a humanoid non-human (a hand-sized fairy) does
    // get boxed sometimes, and the identity pass then NAMES it from the same
    // roster — job_1789304198359_y3n0euk3z p12/p15 carry a detector figure
    // called "Yellow Fairy". So the people count is the real-figure list minus
    // the figures the detector itself named as a VB animal or creature. This,
    // not `realFigureCount`, is what the presence arithmetic compares against
    // (COUNT PEOPLE AGAINST PEOPLE, owner 2026-08-18). The EXPECTED CAST block
    // keeps printing `realFigureCount`: the roster it prints holds the fairies
    // too, so that pair still matches.
    // RESOLVE. One index for this page's name questions — the detector's own
    // figure labels are brief/roster tokens and may be short forms.
    const castIdx = getCastResolver().buildCastIndex(evalOptions.storyData || null, evalOptions.visualBible || null);
    const detectedPeopleCount = (() => {
      if (!Array.isArray(evalOptions.detectedFigures)) return realFigureCount;
      const { countRealFigures, vbNonHumanNames } = require('./bboxDetection');
      const { canonicalName, resolveEntity, isNonHuman } = getCastResolver();
      const nh = new Set(vbNonHumanNames(evalOptions.visualBible || null).map(n => canonicalName(n)));
      if (nh.size === 0) return realFigureCount;
      const nonHumanFigure = (name) =>
        nh.has(canonicalName(name || '')) || isNonHuman(resolveEntity(name, castIdx));
      return countRealFigures(evalOptions.detectedFigures.filter(f => !nonHumanFigure(f?.name)));
    })();
    // WHO THE EVALUATOR CAN ACTUALLY MATCH AGAINST. Filled by the reference
    // attach loop below with the names that reached the critique as a labelled
    // `Reference: <name>` image — not what was requested, what was attached.
    // The presence derivation gates its identity branch on this.
    const attachedReferenceNames = [];
    const expectedCast = buildExpectedCastBlock({
      sceneCharacters,
      sceneHint,
      originalPrompt,
      visualBible: evalOptions.visualBible || null,
      evaluationType,
      detectedFigureCount: realFigureCount,
      pageLabel: pageContext ? `${pageContext} ` : '',
      sceneMetadata: evalOptions.sceneMetadata || null,
      storyData: evalOptions.storyData || null,
      // The cover generator's exclusion list (cap + excluded names) — see the
      // cover branch of buildExpectedCastBlock.
      excludedCastNames: evalOptions.excludedCastNames || null,
      // ONE ROSTER: the two inputs only the detector-side builder used to have.
      pageNumber: evalOptions.pageNumber ?? null,
      extraNames: evalOptions.outlineCharacters || [],
    });
    if (expectedCast.count > 0) {
      log.debug(`👥 [EVAL] ${pageContext}: expected cast (${expectedCast.count}) ${expectedCast.names.join(', ')}`);
    }

    // EVERY CAST MEMBER IS JUDGED AGAINST A REFERENCE. The roster-backed ones
    // arrive as avatars/face photos from the caller; a Visual Bible secondary
    // brings her own reference-sheet cell. One site, so every caller of this
    // function — page eval, cover eval, the Lab stage, the regeneration routes
    // — gets the same roster, and the presence derivation's identity branch
    // has a reference-backed name to claim. See vbCellReferencesForCast.
    {
      const vbRefs = vbCellReferencesForCast({
        castNames: expectedCast.names,
        visualBible: evalOptions.visualBible || null,
        castIndex: castIdx,
        existing: referenceImages || [],
      });
      if (vbRefs.length > 0) {
        referenceImages = [...(referenceImages || []), ...vbRefs];
        log.info(`🧬 [EVAL] ${pageContext}: attaching ${vbRefs.length} visual-bible reference cell(s) as identity reference(s) — ${vbRefs.map(r => `${r.name}${r.vbId ? ` [${r.vbId}]` : ''}`).join(', ')}`);
      }
    }

    // Start semantic evaluation in parallel when we have a reference (page prose
    // or cover brief).
    if (!runFidelity && (evaluationType === 'scene' || isCover)) {
      notEvaluated.record('semantic_fidelity', 'no_fidelity_reference',
        'Neither page prose nor a cover brief was supplied - semantic fidelity did not run');
    }
    if (runFidelity) {
      const { evaluateSemanticFidelity } = require('./sceneValidator');
      semanticPromise = evaluateSemanticFidelity(imageData, fidelityRef, originalPrompt, sceneHint, evalOptions.semanticTemplateOverride || null, {
        artStyle: artStyleForEval,
        clothingContract: clothingContractBlock,
        // ONE ROSTER for the blind judges too (2026-09-14): the kind labels are
        // what keep an `(animal)` entry out of the named-character count.
        expectedCast: expectedCast.block,
        // THE LANDMARK BLOCK (2026-09-18). This judge had none, and it is the
        // judge that produced the one landmark removal that reached production.
        landmarkContext: landmarkContextBlock,
        // Same REQUIRED TEXT allow-list the other two judges get.
        textRules: requiredTextBlock,
      });
      log.debug('🔍 [QUALITY] Starting parallel semantic fidelity evaluation');
    }

    // DECLARED AGES for the compliance judge. The evaluator used to receive
    // head-to-body ratios ("- Daniel: 1:8") and check them itself. That failed
    // twice over: it fired once in 271 versions, and that once was false —
    // three adults all listed 1:8, and the judge read the colon as a ratio
    // BETWEEN two of them ("Daniel is not roughly one-fifth the height of
    // Hans") and demanded an adult be shrunk to a fifth of another adult.
    //
    // Age is the readable form of the same fact. The blind inventory estimates
    // each figure's apparent age from head-to-body proportion without knowing
    // who anyone is, identity supplies the name, and the judge compares that
    // estimate against the number below. No notation to misread, and no
    // cross-character comparison to invent.
    //
    // Declared HERE, above the three-stage launch that reads it. It was first
    // written below that call, where `let` put every read in the temporal dead
    // zone: `evaluateImageQuality` threw ReferenceError on entry, the outer
    // catch returned null, and two whole books (34 pages, staging + prod) were
    // generated with no quality score, no semantic score and no auto-repair
    // before anyone noticed. Same failure class as the hoisted promise handles
    // above. Nothing between here and the call may move below it.
    let expectedAgesBlock = '';
    try {
      const lines = [];
      for (const c of (sceneCharacters || [])) {
        const age = parseInt(c?.age, 10);
        if (c?.name && Number.isFinite(age)) lines.push(`- ${c.name}: ${age} years old`);
      }
      if (lines.length > 0) expectedAgesBlock = lines.join(String.fromCharCode(10));
    } catch { /* silent — the judge tolerates an empty block */ }


    // Start three-stage eval in parallel for scene evaluations.
    // Stage 2 (compliance) needs the quality eval's named figures[] + matches[] so it
    // can pair each named character with the blind vision inventory by zone. We expose
    // those via qualityFiguresResolve, fulfilled once the quality JSON is parsed below.
    if (evaluationType === 'scene' || isCover) {
      // ONE blind inventory per page, launched here and consumed twice: by the
      // compliance judge as Stage 1, and by the figures merge below. It used to
      // be two calls with two prompts describing the same picture.
      // The generated image ALONE — no reference photos, no prompt. Identity is
      // not this call's to decide.
      if (PROMPT_TEMPLATES.imageInventoryUnified && process.env.GEMINI_API_KEY) {
        const invB64 = r2Lib.stripDataUriPrefix(imageData);
        const invMime = imageData.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
        p1Promise = runVisualInventory(
          [{ inline_data: { mime_type: invMime, data: invB64 } }],
          // The inventory has its own judge key since 2026-09-07 (runtime.js
          // `inventoryModel`: Qwen3-VL on staging, 2.5 Flash elsewhere). A
          // Lab quality-model override still wins so an A/B measures one model.
          qualityModelOverride || MODEL_DEFAULTS.inventoryModel || MODEL_DEFAULTS.qualityEval || 'gemini-2.5-flash',
          process.env.GEMINI_API_KEY, pageContext
        );
        log.debug(`📊 [EVAL P1] Shared blind inventory launched for ${pageContext || 'scene'}`);
      }
      qualityFiguresPromise = new Promise((resolve) => { qualityFiguresResolve = resolve; });
      // THE BLIND COMPLIANCE JUDGE IS GATED (owner, 2026-09-19). Default OFF —
      // MODEL_DEFAULTS.promptComplianceJudge, env PROMPT_COMPLIANCE_JUDGE=true
      // to re-arm without a deploy. OFF means the Stage-2 call is NOT MADE, so
      // `threeStagePromise` stays null and every `threeStageResult` reader below
      // sees null — the shape they already handle for "the judge failed".
      //
      // Stage 1 (p1Promise, above) deliberately stays OUTSIDE this gate: the
      // quality eval's own figure merge consumes it further down, and that feeds
      // the empty-inventory score floor in images.js. Gating stage 1 would move
      // scores; gating stage 2 does not.
      //
      // The absence is RECORDED, not silent. Without the entry below, a page
      // judged with this off is byte-for-byte a page the judge cleared — the
      // exact conflation notEvaluated.js exists to remove. Recording only: this
      // entry is never a deduction and never routes a page to repair.
      // THE LAB FOLLOWS PRODUCTION BY DEFAULT, and can opt back in explicitly.
      // This stage is the harness that measured the judge (experiment 1333), so
      // it must stay able to run it — but always-on here would be the Lab/prod
      // drift the sibling registry exists to catch, so the knob is explicit:
      // `complianceJudgeOverride` true forces the judge on, false forces it off,
      // null/absent follows the production flag.
      const complianceJudgeOn = evalOptions.complianceJudgeOverride == null
        ? MODEL_DEFAULTS.promptComplianceJudge
        : !!evalOptions.complianceJudgeOverride;
      if (!complianceJudgeOn) {
        notEvaluated.record(
          'prompt_compliance',
          'compliance_judge_disabled',
          'The blind prompt-compliance judge did not run (promptComplianceJudge is off) — nothing on this page was checked against the prompt by that judge'
        );
        log.debug(`📊 [THREE-STAGE] ${pageContext || 'scene'}: compliance judge OFF (promptComplianceJudge=false; set PROMPT_COMPLIANCE_JUDGE=true to re-arm) — Stage 2 not called; Stage 1 inventory still ran`);
      } else {
        threeStagePromise = evaluateThreeStage(imageData, originalPrompt, sceneHint, {
          inventoryPromise: p1Promise,
          expectedAges: expectedAgesBlock,
          pageContext,
          storyText: fidelityRef,
          qualityFiguresPromise,
          complianceModelOverride: evalOptions.complianceModelOverride || null,
          compliancePromptOverride: evalOptions.compliancePromptOverride || null,
          artStyle: artStyleForEval,
          clothingContract: clothingContractBlock,
          // ONE ROSTER (2026-09-14). The compliance judge had no cast list at all.
          expectedCast: expectedCast.block,
          // Resolves the VB ids in INTERACTIONS_BLOCK to real names when the
          // caller has a bible; without one they still become generic nouns.
          visualBible: evalOptions.visualBible || null,
          // Era-aware landmark protection inputs (2026-09-05). Callers that know
          // the page's landmark refs + era pass them; everything else defaults to
          // no protection, i.e. unchanged behaviour.
          landmarkPhotos: evalOptions.landmarkPhotos || null,
          era: evalOptions.era || null,
          // Same REQUIRED TEXT allow-list the other two judges get. Without it
          // this judge scores a correctly spelled required string as
          // unrequested lettering: its own rule counts a string as asked-for
          // only when the prompt QUOTES it.
          textRules: requiredTextBlock,
        });
        log.debug(`📊 [QUALITY] Starting parallel three-stage evaluation`);
      }
    }

    // Extract base64 and mime type for generated image
    const base64Data = r2Lib.stripDataUriPrefix(imageData);
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Use standard evaluation for all images (scenes + covers)
    // Covers get the expected text prepended so the evaluator checks text accuracy too
    let evaluationTemplate;
    if (evalOptions.evalTemplateOverride) {
      evaluationTemplate = evalOptions.evalTemplateOverride;
      log.verbose(`📊 [EVAL] Using OVERRIDE evaluation template (${evaluationType})`);
    } else if (PROMPT_TEMPLATES.imageEvaluation) {
      evaluationTemplate = PROMPT_TEMPLATES.imageEvaluation;
      log.verbose(`📊 [EVAL] Using standard evaluation (${evaluationType})`);
    } else {
      evaluationTemplate = null;
    }
    // O7: hash of the template that produced this score. Prompt-file edits
    // silently change what a historical score means — the hash makes each
    // stored eval traceable to its template version.
    const evalTemplateHash = evaluationTemplate
      ? require('crypto').createHash('md5').update(evaluationTemplate).digest('hex').slice(0, 8)
      : null;

    // Determine model to use (parameter override > config default > fallback)
    // let: may be reassigned to fallback model on content block
    let modelId = qualityModelOverride || MODEL_DEFAULTS.qualityEval || 'gemini-2.5-flash';

    // Pre-sanitize for 2.5 models to reduce content blocking on first attempt
    let promptForEval = modelId.includes('2.5') ? sanitizeForGemini(originalPrompt, 'light') : originalPrompt;
    // Resolved from the UNSTRIPPED prompt: the cover branch below deletes the
    // ART STYLE block from promptForEval as evaluator noise, which would leave
    // artStyleForEval / clothingContractBlock: built above, before the
    // parallel evals started, so all three evaluators receive them.

    // For cover evaluations: strip art style noise and prepend expected text prominently
    if (evaluationType === 'cover' && promptForEval) {
      // Expected text arrives STRUCTURED (evalOptions.expectedText / textMode)
      // from the pipeline's cover pseudo-page record. Prompt-regex extraction
      // remains as fallback for callers that evaluate against the raw
      // generation prompt (the templates say `Paint "{STORY_TITLE}" in the
      // upper third` etc.) — without the Paint pattern a misspelled painted
      // title ("gelhen") once sailed through at score 85.
      const textMode = evalOptions.textMode || null;
      let expectedText = evalOptions.expectedText || null;
      if (!expectedText && textMode !== 'appOverlay') {
        const titleMatch = promptForEval.match(/MUST include this exact (?:title |dedication )?text:\s*"([^"]+)"/i);
        const magicalMatch = promptForEval.match(/MUST include this exact text:\s*"(magicalstory\.ch)"/i);
        const paintMatch = promptForEval.match(/Paint\s+"([^"]+)"\s+(?:in|as)\b/i);
        expectedText = titleMatch?.[1] || magicalMatch?.[1] || paintMatch?.[1];
        if (expectedText) expectedText = expectedText.replace(/<\/?user_input>/g, '').trim();
      }

      // Strip art style description (noise for evaluator)
      promptForEval = promptForEval.replace(/\*\*ART STYLE[^*]*\*\*[^*]*(?=\*\*|$)/s, '');

      // The three cover notes live in prompts/cover-evaluation-notes.txt
      // (sections COVER_NOTE / TEXT_NOTE_APP_OVERLAY / TEXT_RULES) so the
      // cover generator/critic pair is a registry set over two file paths.
      const coverNotes = promptSections(PROMPT_TEMPLATES.coverEvaluationNotes);
      // Loud, not "undefined": these are interpolated straight into the judge's
      // prompt, so a missing template would put the literal string "undefined"
      // in front of the evaluator. Same guard the plate judge carries.
      if (!coverNotes.COVER_NOTE) throw new Error('evaluateImageQuality: cover-evaluation-notes template not loaded (COVER_NOTE)');

      // Cover portraits: viewer-gaze and a flat title are intended, not defects.
      promptForEval = `${coverNotes.COVER_NOTE}\n\n${promptForEval}`;

      if (textMode === 'appOverlay' && !coverNotes.TEXT_NOTE_APP_OVERLAY) {
        throw new Error('evaluateImageQuality: cover-evaluation-notes template has no TEXT_NOTE_APP_OVERLAY section');
      }
      if (textMode !== 'appOverlay' && expectedText && !coverNotes.TEXT_RULES) {
        throw new Error('evaluateImageQuality: cover-evaluation-notes template has no TEXT_RULES section');
      }
      if (textMode === 'appOverlay') {
        // Mode B: art is textless; title/dedication/branding composited by the
        // app after persistence. Was previously appended to the pseudo-page's
        // sceneDescription as string surgery (server.js pipeline entry).
        promptForEval = `${coverNotes.TEXT_NOTE_APP_OVERLAY}\n\n${promptForEval}`;
      } else if (expectedText) {
        promptForEval = `${fillTemplate(coverNotes.TEXT_RULES, { EXPECTED_TEXT: expectedText })}\n\n${promptForEval}`;
      }
    }

    // Extract declared character interactions from the scene metadata.
    // Use sceneHint (original scene description with metadata block) rather than
    // originalPrompt (image prompt where metadata was already stripped).
    // Same shared builder as the compliance stage — `i.object` is a raw VB id.
    let interactionsBlock = '(none declared)';
    let sceneIntentBlock = '(none declared)';
    try {
      const interactionSource = sceneHint || originalPrompt;
      const sceneMeta = getStoryHelpers().extractSceneMetadata(interactionSource);
      const interactions = sceneMeta?.interactions
        || (Array.isArray(sceneMeta?.fullData?.interactions) ? sceneMeta.fullData.interactions : null);
      interactionsBlock = require('./vbIdGuard')
        .formatInteractionsBlock(interactions, evalOptions.visualBible || null, require('./vbIdGuard').gazeCharacters(sceneMeta));
      const intent = sceneMeta?.sceneIntent || sceneMeta?.fullData?.sceneIntent;
      if (intent && String(intent).trim()) sceneIntentBlock = String(intent).trim();
    } catch { /* silent — evaluator defaults to "(none declared)" */ }

    // CLOTHING CONTRACT (owner, 2026-08-08). The evaluator used to infer the
    // outfit from ORIGINAL_PROMPT alone. When the prompt carried no clothing —
    // job_1786193650012_7baiaeftb page 11 v2 had none at all, not even the word
    // "wears" — it invented one from the story's theme ("a full pirate costume
    // including red-and-white striped trousers and a black waistcoat") and
    // flagged the CORRECT wardrobe as wrong, four times, sinking the one
    // properly-dressed version of that page. Pass the resolved per-page outfit
    // as its own input so the judge compares against the contract, not against
    // its prior of what a pirate looks like. Empty when unknown — the template
    // then tells it not to judge clothing at all, which is the honest default.
    const { buildEvaluationPrompt } = require('../services/prompts');
    const evaluationPrompt = evaluationTemplate
      ? buildEvaluationPrompt({
          originalPrompt: promptForEval,
          artStyle: artStyleForEval,
          interactionsBlock,
          sceneIntent: sceneIntentBlock,
          clothingContract: clothingContractBlock,
          requiredObjects: requiredObjectsBlock,
          textRules: requiredTextBlock,
          expectedCast: expectedCast.block,
          // THE LANDMARK BLOCK (2026-09-18) — same block the other two judges
          // get, from the same builder.
          landmarkContext: landmarkContextBlock,
          template: evalOptions.evalTemplateOverride || undefined,
        })
      : 'Evaluate this AI-generated children\'s storybook illustration on a scale of 0-100. Consider: visual appeal, clarity, artistic quality, age-appropriateness, and technical quality. Respond with ONLY a number between 0-100, nothing else.';

    // Build content array for Gemini format
    const parts = [
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      }
    ];

    // Add reference images if provided (compressed and cached for token efficiency)
    // Supports both: array of URLs (legacy) or array of {name, photoUrl} objects (new)
    // Sources are resolved via bytesFromAnyImage: inline data: URIs (generation-time)
    // AND http(s) R2 URLs (post-save paths — stripInlineImagesFromStoryData sweeps
    // every inline byte out of stories.data, so re-evaluate / repair rounds hand
    // this function URL refs). Before this, non-data: refs were silently dropped
    // → the quality eval and P1 inventory ran with ZERO labeled reference photos
    // → matches[] came back empty → the compliance stage flagged every named
    // character as unidentified (identity CRITICALs → repair loop on covers).
    if (referenceImages && referenceImages.length > 0) {
      let addedCount = 0;
      let cacheHits = 0;
      let skippedCount = 0;
      for (const refImg of referenceImages) {
        // Handle both formats: string URL or {name, photoUrl} object
        const photoUrl = typeof refImg === 'string' ? refImg : refImg?.photoUrl;
        const charName = typeof refImg === 'object' ? refImg?.name : null;
        const isVbCell = typeof refImg === 'object' && !!refImg?.vbCell;
        if (!photoUrl || typeof photoUrl !== 'string') { skippedCount++; continue; }
        try {
          // Cache key: hash of the source string (data URI payload or URL) — stable per ref
          const imageHash = require('./images').hashImageData(photoUrl);
          let compressedBase64 = require('./images').compressedRefCache.get(imageHash);

          if (compressedBase64) {
            cacheHits++;
          } else {
            let dataUri = photoUrl;
            if (!photoUrl.startsWith('data:image')) {
              const buf = await r2Lib.bytesFromAnyImage(photoUrl); // https / raw base64 → Buffer, null on unsupported
              if (!buf) {
                skippedCount++;
                log.warn(`⚠️ [EVAL] Reference photo${charName ? ` "${charName}"` : ''} could not be resolved to bytes (${photoUrl.substring(0, 40)}...) — skipping`);
                continue;
              }
              dataUri = `data:image/jpeg;base64,${buf.toString('base64')}`;
            }
            // Compress and cache
            const compressed = await require('./images').compressImageToJPEG(dataUri, 85, 768); // 85% quality, max 768px
            compressedBase64 = r2Lib.stripDataUriPrefix(compressed);
            require('./images').compressedRefCache.set(imageHash, compressedBase64);
          }

          // Add label with character name so Gemini can identify by name (not just "Reference 1")
          if (charName) {
            // A VB cell is a DRAWING of the character, not a photograph of
            // one. The judge is told which it is holding so it reads identity
            // from face, hair and build and never files the rendering medium
            // as a difference.
            parts.push({ text: isVbCell
              ? `Reference: ${charName}
(drawn visual-bible reference cell, not a photo - judge identity by face, hair and build only)`
              : `Reference: ${charName}` });
          }
          parts.push({
            inline_data: {
              mime_type: 'image/jpeg',
              data: compressedBase64
            }
          });
          addedCount++;
          if (charName) attachedReferenceNames.push(String(charName));
        } catch (refErr) {
          skippedCount++;
          log.warn(`⚠️ [EVAL] Reference photo${charName ? ` "${charName}"` : ''} failed to load (${refErr.message}) — skipping`);
        }
      }
      log.verbose(`📊 [EVAL] Added ${addedCount} reference images (${cacheHits} cached, ${addedCount - cacheHits} compressed)`);
      if (skippedCount > 0) {
        log.warn(`⚠️ [EVAL] ${skippedCount}/${referenceImages.length} reference photos unusable — figure-identity matching will be degraded${addedCount === 0 ? ' (NO references: matches[] will be empty)' : ''}`);
        // Blind check #51 in the shape it actually shipped: the judge received
        // fewer reference photos than the cast and graded identity anyway.
        notEvaluated.record('identity', 'reference_photos_unusable',
          `${skippedCount}/${referenceImages.length} reference photo(s) could not be attached - figure-identity matching is degraded`);
      }
      // References requested but NONE attached → the eval is identity-blind and
      // its score is not countable. On job_1786571353564 p4/p9 the recolour
      // versions were graded exactly like this (the model wrote "no reference
      // photos provided for matching") and a character repainted entirely red
      // passed 100/PASS. Fail the eval instead: callers already treat a null
      // eval as "no score → no version" (recolour) / re-eval (batch retry).
      if (referenceImages.length > 0 && addedCount === 0) {
        log.error(`❌ [EVAL] ${pageContext}: ${referenceImages.length} reference photo(s) supplied, 0 attached — refusing to grade identity-blind; eval fails instead of returning an unanchored score`);
        // Countable, not just scrollback: shows up in story_metrics counters.
        try {
          require('./runMetrics').forJob(evalOptions?.storyMeta?.storyId).count('eval_refs_attach_failed');
        } catch { /* metrics are best-effort */ }
        return null;
      }
    } else {
      // NO references supplied at all. Same blindness as "supplied but none
      // attached" and previously the only one of the two that said nothing:
      // this branch recorded no notEvaluated entry, so an identity-blind eval
      // and a clean one were the same signal in the stored story.
      notEvaluated.record('identity', 'no_reference_photos',
        'no reference photo was supplied - figure identity was not judged against the cast');
    }

    // === LAUNCH P1 VISUAL INVENTORY IN PARALLEL (age/figure detection) ===
    // Covers included — the standing-surface / implausible-placement signal that
    // catches "characters in the river" lives in this inventory pass.

    // Add evaluation prompt text
    parts.push({ text: evaluationPrompt });

    // Log if using model override (modelId already defined at top of function)
    if (qualityModelOverride) {
      log.debug(`🔧 [QUALITY] Using model override: ${modelId}`);
    }

    // Helper function to call the API with retry for socket errors.
    // thinkingBudget caps how many of the 32k output tokens Gemini may spend on
    // hidden reasoning. Without a cap, 2.5 Flash has been observed burning the
    // entire budget on thinking (30k+) and emitting truncated JSON → MAX_TOKENS.
    const callQualityAPI = async (model, thinkingBudget = EVAL_THINKING_BUDGET) => {
      assertPromptFilled(parts, 'evaluateImageQuality');
      // Route to Grok vision API for xAI models
      const modelConfig = TEXT_MODELS[model];
      if (modelConfig?.provider === 'xai') {
        return require('./images').callGrokVisionAPI(model, modelConfig.modelId || model, parts, evaluationPrompt);
      }
      // OpenRouter vision judge (Qwen3-VL etc.): same Gemini-shaped response
      // as the Grok path, so the parsing below is provider-blind. Lab A/B of
      // the quality judge (2026-09-08); no fallback here — a failed call
      // returns non-2xx and the eval is skipped like any other API error.
      if (modelConfig?.provider === 'openrouter') {
        return require('./images').callOpenRouterVisionAPI(model, modelConfig.modelId || model, parts, evaluationPrompt);
      }
      return withRetry(async () => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            // No maxOutputTokens (owner rule: no output caps) — Gemini's default
            // is the model's own ceiling; finishReason MAX_TOKENS is checked below.
            generationConfig: {
              // Evaluation is a judgment task — temperature 0 minimises the
              // run-to-run severity/detection swing (same image scored 0 vs 60
              // on consecutive runs at 0.3). thinkingBudget: 0 disables the
              // hidden reasoning pass, another variance source for this
              // structured check. Both env-overridable for A/B.
              temperature: EVAL_TEMPERATURE,
              thinkingConfig: { thinkingBudget }
            },
            safetySettings: require('./images').GEMINI_SAFETY_SETTINGS
          }),
          // No timeout here froze jobs mid-eval (stuck-at-51% incident,
          // 2026-07-07); abort feeds withRetry, then the eval is skipped.
          signal: AbortSignal.timeout(120000)
        });
      }, { maxRetries: 2, baseDelay: 2000 });
    };

    let response = await callQualityAPI(modelId);

    if (!response.ok) {
      const error = await response.text();
      log.error('❌ [QUALITY] Gemini API error:', error);
      return null;
    }

    let data = await response.json();

    // Extract and log token usage for quality evaluation
    const qualityInputTokens = data.usageMetadata?.promptTokenCount || 0;
    const qualityOutputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    const qualityThinkingTokens = data.usageMetadata?.thoughtsTokenCount || 0;
    if (qualityInputTokens > 0 || qualityOutputTokens > 0) {
      const thinkingInfo = qualityThinkingTokens > 0 ? `, thinking: ${qualityThinkingTokens.toLocaleString()}` : '';
      log.verbose(`📊 [EVAL] Token usage - input: ${qualityInputTokens.toLocaleString()}, output: ${qualityOutputTokens.toLocaleString()}${thinkingInfo}`);
    }

    // Blocked content: retry with full sanitization, then fall back to Grok vision.
    if (isBlockedResponse(data)) {
      const pageLabel = pageContext ? `[${pageContext}] ` : '';
      const promptBlockReason = data.promptFeedback?.blockReason || null;
      const promptSafety = data.promptFeedback?.safetyRatings?.map(r => `${r.category}:${r.probability}${r.blocked ? '(BLOCKED)' : ''}`).join(', ') || 'none';
      const candFinish = data.candidates?.[0]?.finishReason || 'none';
      const candSafety = data.candidates?.[0]?.safetyRatings?.map(r => `${r.category}:${r.probability}${r.blocked ? '(BLOCKED)' : ''}`).join(', ') || 'none';
      const reason = promptBlockReason || candFinish;
      log.info(`[QUALITY] ${pageLabel}Gemini safety block (${reason}), retrying with sanitization...`);
      log.debug(`[QUALITY] ${pageLabel}Safety details: prompt=[${promptSafety}], candidate=[${candSafety}]`);

      // Step 1: Retry with full sanitization (strips all gender/age nouns).
      // Go through buildEvaluationPrompt so the retry keeps the same block
      // contract as the primary path — a raw fillTemplate here dropped
      // SCENE_INTENT, leaving the safety-retry eval blind to scene intent on
      // exactly the pages a safety block forced us to re-run. (It also dropped
      // the figure-proportions block, which no longer exists: age is checked
      // by the compliance judge against the blind inventory's apparent_age.)
      const fullSanitized = sanitizeForGemini(originalPrompt, 'full');
      const { buildEvaluationPrompt } = require('../services/prompts');
      const fullEvalPrompt = evaluationTemplate
        ? buildEvaluationPrompt({
            originalPrompt: fullSanitized,
            artStyle: artStyleForEval,
            interactionsBlock,
            sceneIntent: sceneIntentBlock,
            clothingContract: clothingContractBlock,
            requiredObjects: requiredObjectsBlock,
            textRules: requiredTextBlock,
            expectedCast: expectedCast.block,
            template: evalOptions.evalTemplateOverride || undefined,
          })
        : evaluationPrompt;
      parts[parts.length - 1] = { text: fullEvalPrompt };
      try {
        const retryResponse = await callQualityAPI(modelId);
        if (retryResponse.ok) {
          const retryData = await retryResponse.json();
          if (!isBlockedResponse(retryData)) {
            log.info(`✅ [QUALITY] ${pageLabel}Full sanitization retry succeeded`);
            data = retryData;
          } else {
            data = retryData; // still blocked — fall through to Grok
          }
        }
      } catch (retryErr) {
        log.warn(`⚠️ [QUALITY] ${pageLabel}Full sanitization retry failed: ${retryErr.message}`);
      }

      // Step 2: Grok vision fallback if still blocked
      if (isBlockedResponse(data)) {
        const usedModelConfig = TEXT_MODELS[modelId];
        if (usedModelConfig?.provider !== 'xai') {
          const grokFallbackId = GROK_VISION_FALLBACK;
          const grokFallbackModel = TEXT_MODELS[grokFallbackId];
          if (grokFallbackModel?.provider === 'xai') {
            log.info(`🔄 [QUALITY] ${pageLabel}Still blocked, falling back to Grok vision (${grokFallbackId})...`);
            try {
              const grokResponse = await require('./images').callGrokVisionAPI(grokFallbackId, grokFallbackModel.modelId || grokFallbackId, parts, fullEvalPrompt);
              if (grokResponse.ok) {
                const grokData = await grokResponse.json();
                if (grokData?.candidates?.[0]?.content?.parts?.[0]?.text) {
                  log.info(`✅ [QUALITY] ${pageLabel}Grok fallback succeeded`);
                  data = grokData;
                } else {
                  log.error(`❌ [QUALITY] ${pageLabel}Grok fallback returned no text`);
                  return null;
                }
              } else {
                log.error(`❌ [QUALITY] ${pageLabel}Grok fallback HTTP error`);
                return null;
              }
            } catch (grokErr) {
              log.error(`❌ [QUALITY] ${pageLabel}Grok fallback failed: ${grokErr.message}`);
              return null;
            }
          } else {
            return null;
          }
        } else {
          return null;
        }
      }
    }

    // Log finish reason to diagnose early stops
    let finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      log.warn(`⚠️  [QUALITY] Gemini finish reason: ${finishReason}`);
    }

    // MAX_TOKENS retry: thinking ate the budget → retry once with a tighter
    // thinkingBudget so the model has more room for the actual JSON output.
    // Failing fast (returning null) is preferable to silently hanging the pipeline.
    if (finishReason === 'MAX_TOKENS' && TEXT_MODELS[modelId]?.provider !== 'xai') {
      log.warn(`⚠️  [QUALITY] MAX_TOKENS — retrying once with thinkingBudget=2048`);
      try {
        const retry = await callQualityAPI(modelId, 2048);
        if (retry.ok) {
          const retryData = await retry.json();
          const retryFinish = retryData.candidates?.[0]?.finishReason;
          if (retryData.candidates?.[0]?.content?.parts?.[0]?.text && retryFinish !== 'MAX_TOKENS') {
            log.info(`✅ [QUALITY] MAX_TOKENS retry succeeded`);
            data = retryData;
            finishReason = retryFinish;
          } else {
            log.warn(`⚠️  [QUALITY] MAX_TOKENS retry still truncated (finishReason=${retryFinish}) — giving up on this eval`);
            return null;
          }
        } else {
          log.warn(`⚠️  [QUALITY] MAX_TOKENS retry HTTP error — giving up on this eval`);
          return null;
        }
      } catch (retryErr) {
        log.warn(`⚠️  [QUALITY] MAX_TOKENS retry threw: ${retryErr.message} — giving up on this eval`);
        return null;
      }
    }

    if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
      const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'unknown';
      log.warn(`⚠️  [QUALITY] No text response (reason: ${reason})`);
      return null;
    }

    const responseText = data.candidates[0].content.parts[0].text.trim();

    // Parse FIX_TARGETS section if present (bounding boxes for auto-repair)
    const parseFixTargets = (text) => {
      const fixTargets = [];
      // Look for FIX_TARGETS: section
      const fixTargetsMatch = text.match(/FIX_TARGETS:[\s\S]*?(?=\n\n|\*\*|$)/i);
      if (fixTargetsMatch) {
        // Find all JSON objects on separate lines
        const lines = fixTargetsMatch[0].split('\n');
        for (const line of lines) {
          const jsonMatch = line.match(/\{.*\}/);
          if (jsonMatch) {
            try {
              const target = JSON.parse(jsonMatch[0]);
              if (target.bbox && Array.isArray(target.bbox) && target.bbox.length === 4) {
                fixTargets.push({
                  boundingBox: target.bbox, // [ymin, xmin, ymax, xmax]
                  issue: target.issue || 'unknown issue',
                  fixPrompt: target.fix || 'fix the issue'
                });
              }
            } catch (e) {
              log.debug(`📊 [EVAL] Could not parse FIX_TARGET: ${line}`);
            }
          }
        }
      }
      if (fixTargets.length > 0) {
        log.info(`📊 [EVAL] Parsed ${fixTargets.length} fix targets with bounding boxes`);
      }
      return fixTargets;
    };

    const fixTargets = parseFixTargets(responseText);

    // Try to parse as JSON (new format with 0-10 scale)
    let parsedJson = null;
    try {
      // Extract JSON from response (may have markdown code blocks)
      parsedJson = getStoryHelpers().extractJsonFromText(responseText);
    } catch (e) {
      log.debug(`📊 [EVAL] Response is not JSON, trying legacy format`);
    }

    // Gate on the DEFECT REPORT, not on a score. The prompts stopped emitting
    // `score` (b9658b501: "the prompts report defects; the score is the defects")
    // but this condition still required it, so every well-formed evaluation fell
    // through to the legacy regex fallbacks, matched none of them, and returned
    // null — which left the three-stage compliance call waiting forever on
    // figures[]/matches[] that never arrived. Recognise the response by the
    // fields the prompt actually produces.
    const isDefectReport = parsedJson && typeof parsedJson === 'object' && (
      Array.isArray(parsedJson.fixable_issues) || Array.isArray(parsedJson.figures)
      || parsedJson.coherence_gate || typeof parsedJson.verdict === 'string'
      || typeof parsedJson.score === 'number'
    );
    if (isDefectReport) {
      // The score below is DERIVED from the defect list; parsedJson.score is
      // deliberately not read even when a stale prompt still emits one.
      const verdict = parsedJson.verdict || parsedJson.final_verdict || 'UNKNOWN';
      // Support both old 'issues' and new 'issues_summary' field
      // Handle case where issues might be an array (convert to string)
      let issuesSummary = parsedJson.issues_summary || parsedJson.issues || '';
      if (Array.isArray(issuesSummary)) {
        issuesSummary = issuesSummary.join('. ');
      } else if (typeof issuesSummary !== 'string') {
        issuesSummary = String(issuesSummary);
      }

      // Parse fixable_issues from JSON (new two-stage format - no bboxes)
      // These will be enriched with bounding boxes in a separate detection step
      let fixableIssues = parseFixableIssues(parsedJson);
      {
        if (fixableIssues.length > 0) {
          const proportionCount = fixableIssues.filter(f => f.type === 'proportion').length;
          if (proportionCount > 0) {
            log.info(`📊 [EVAL] Parsed ${fixableIssues.length} fixable issues (two-stage detection, ${proportionCount} proportion)`);
          } else {
            log.info(`📊 [EVAL] Parsed ${fixableIssues.length} fixable issues (two-stage detection)`);
          }
        }
      }

      // STEP 0 COHERENCE GATE (wired 2026-08-06). image-evaluation.txt has always
      // asked for `coherence_gate: {applied, reason}` — the "this image cannot be
      // published, repainting one region cannot save it" verdict — and NOTHING in
      // the codebase ever read it. It was write-only: the model emitted it, it sat
      // in the raw reasoning text, and the redo it exists to trigger could not
      // happen. Observed cost: a page framed by a full-perimeter comic-book border
      // (a listed catastrophic trigger) was reported in STEP 4 as
      // `composition/MINOR` instead, scored 68 — the highest in the book — and
      // shipped unrepaired.
      //
      // The gate does not get its own repair path. Catastrophic severity already
      // routes to regenerate (repairLogic: catastrophic visual/semantic → iterate),
      // so an applied gate is expressed as a CATASTROPHIC issue and rides the
      // existing route. If the model applied the gate but severitied the same
      // defect lower in STEP 4, the gate wins — that mismatch is exactly the
      // failure above.
      const coherenceGate = parsedJson.coherence_gate || null;
      if (coherenceGate?.applied === true) {
        const reason = coherenceGate.reason || 'image is fundamentally broken (coherence gate)';
        const alreadyCatastrophic = fixableIssues.some(i => /catastrophic/i.test(String(i.severity || '')));
        if (!alreadyCatastrophic) {
          fixableIssues.unshift({
            description: reason,
            severity: 'CATASTROPHIC',
            type: 'coherence',
            character: null,
            fix: `Regenerate the page from scratch: ${reason}`,
          });
          log.warn(`🚧 [EVAL] coherence gate APPLIED → forcing CATASTROPHIC (no STEP 4 issue matched it): ${reason}`);
        } else {
          log.warn(`🚧 [EVAL] coherence gate APPLIED: ${reason}`);
        }
      }

      // STYLE GATE (wired 2026-08-09). The medium check spent its life as a
      // defect code — D-27, 27th of 28 — and fired ZERO times in every story
      // measured. Moving it to the front of the prompt (folded into N-01)
      // changed nothing: replayed on two known-photoreal pages of a steampunk
      // book (exp #488), one came back a clean PASS, 100/100, zero defects.
      // A rule can be skimmed wherever it sits; a required output FIELD cannot.
      //
      // The prompt now asks for the observed medium FIRST, in the model's own
      // words, before it is allowed to look at what was commissioned — naming
      // what you see is harder to skip than judging against a spec.
      const styleGate = parsedJson.style_gate || null;
      if (styleGate) {
        // Medium alone was too coarse: it catches a PHOTOGRAPH in a drawn book
        // and nothing else. Watercolour, comic and anime are all "illustration"
        // — what separates them is linework and, above all, how a FACE is
        // rendered, which is why every ART_STYLES descriptor carries a "Faces:"
        // clause. A flat-vector page with simple outlined faces in a book
        // commissioned for ink linework passed the medium-only gate.
        const observed = String(styleGate.observed || '').trim();
        const linework = String(styleGate.linework || '').trim();
        const faces = String(styleGate.faces || '').trim();
        const seen = [observed, linework && `linework: ${linework}`, faces && `faces: ${faces}`]
          .filter(Boolean).join(' | ');
        if (styleGate.matches_style === false) {
          // Gate wins over a mis-severitied STEP 4 finding — same precedence as
          // the coherence gate, and the same failure it exists to prevent.
          const already = fixableIssues.some(i => /style_consistency/i.test(String(i.type || '')));
          if (!already) {
            const reason = styleGate.reason
              || `page is rendered as ${observed || 'a different medium'}, not the commissioned art style`;
            fixableIssues.unshift({
              description: reason,
              severity: 'MAJOR',
              type: 'style_consistency',
              character: null,
              fix: 'Regenerate the page in the commissioned art style — match the medium, not just the subject.',
            });
            log.warn(`🎨 [EVAL] style gate FAILED — saw [${seen}] → style_consistency MAJOR: ${reason}`);
          } else {
            log.warn(`🎨 [EVAL] style gate FAILED — saw [${seen}] — STEP 4 already reported it`);
          }
        } else if (observed) {
          // INFO, not debug. The whole point of a gate is that its answer is
          // observable; logging the normal case at debug made "the model said
          // it matches" indistinguishable from "the model never answered",
          // which cost two inconclusive investigations.
          log.info(`🎨 [EVAL] style gate: saw [${seen}] — matches the commissioned style`);
        } else {
          log.warn('🎨 [EVAL] style gate returned no `observed` value — medium was not actually named');
        }
      } else {
        // Absence is itself the signal: the field is mandatory, so a missing
        // one means the model skipped the gate (or an old prompt is live).
        log.warn('🎨 [EVAL] style_gate MISSING from the evaluator response — medium was not checked');
      }

      // MULTI-JUDGE JURY (EVAL_JUDGES): run the extra judges (Grok, Qwen) on the
      // SAME parts, then merge ALL judges by PURE MEDIAN per bucket (evalBuckets)
      // and replace fixableIssues with the deduplicated merged set before scoring.
      // Default EVAL_JUDGES=gemini → runExtraJudges returns [] → single-judge path
      // unchanged (zero prod behaviour change). NOTE: the merge de-duplicates issues
      // into one severity per bucket, which changes score magnitude — the redo
      // threshold must be A/B-calibrated in the Test Lab before the jury drives prod.
      try {
        const { getEvalJudges, runExtraJudges } = require('./evalJudges');
        const judges = getEvalJudges();
        if (judges.length > 1) {
          const extra = await runExtraJudges({ parts, judges });
          if (extra.length) {
            const { mapIssuesToBuckets, mergeJudges, bucketsToIssues } = require('./evalBuckets');
            // bySubject: merge per (bucket, SUBJECT). Merging per bucket alone
            // collapses two characters' findings of one class into one entry,
            // and scoring bills per (class, subject) — so a plain bucket merge
            // silently reverts every page to a single charge per class.
            const opts = { bySubject: true };
            const vectors = [mapIssuesToBuckets(fixableIssues, opts), ...extra.map(e => mapIssuesToBuckets(e.fixableIssues, opts))];
            const merged = mergeJudges(vectors);
            const mergedIssues = bucketsToIssues(merged);
            const lowConf = Object.values(merged).filter(m => m.lowConfidence).length;
            log.info(`🧑‍⚖️ [EVAL] Jury ${vectors.length} judges (gemini,${extra.map(e => e.judge).join(',')}) → ${mergedIssues.length} merged buckets (${lowConf} low-confidence)`);
            fixableIssues = mergedIssues.map(m => ({
              description: m.description,
              severity: String(m.severity).toUpperCase(),
              type: m.type,
              // Survives the merge now that the vectors are keyed by
              // (bucket, subject) — see the bySubject note above.
              character: m.character || null,
              fix: `Fix: ${m.description}`,
              // The merge has no judge's edit instruction to carry — this line
              // is built from the description, so it is never an edit
              // instruction and the landmark guard must not read it as one.
              fixAuthored: false,
              agreement: m.agreement,
            }));
          }
        }
      } catch (juryErr) {
        log.warn(`[EVAL] multi-judge merge skipped (${juryErr.message}) — using primary judge only`);
        // The returned result still carries `agreement` fields as if the jury
        // ran; without this entry a 1-judge run reads like a 3-judge consensus.
        notEvaluated.record('judge_jury', 'jury_merge_failed', juryErr.message);
      }

      // STATS: record the (merged) buckets to eval_findings for per-style/genre
      // reporting. Best-effort, fire-and-forget; only records when the caller
      // passes evalOptions.storyMeta (else skipped). Works in single- and
      // multi-judge mode so stats populate even before the jury is enabled.
      try {
        const sm = evalOptions && evalOptions.storyMeta;
        if (sm && sm.storyId) {
          const { mapIssuesToBuckets } = require('./evalBuckets');
          const db = require('../services/database');
          const vec = mapIssuesToBuckets(fixableIssues);
          const rows = Object.entries(vec).map(([bucket, m]) => ({
            story_id: sm.storyId, page_number: sm.pageNumber ?? null, bucket,
            severity: String(m.severity).toLowerCase(), eval_type: evaluationType,
            art_style: sm.artStyle || null, genre: sm.genre || null, language: sm.language || null,
            char_count: sm.charCount ?? null, judges: process.env.EVAL_JUDGES || 'gemini',
          }));
          // Fire-and-forget, but NEVER silent: a bare `.catch(() => {})` here is
          // half of why this sink recorded nothing for its whole lifetime.
          // recordEvalFindings swallows its own DB errors loudly; this catch is
          // only for a rejection it could not handle. Log, never throw.
          if (rows.length && typeof db.recordEvalFindings === 'function') {
            db.recordEvalFindings(rows).catch(err =>
              log.error(`[EVAL] eval_finding_stats write rejected: ${err && err.message}`));
          }
        }
      } catch (recErr) {
        log.warn(`[EVAL] eval_findings record skipped (${recErr.message})`);
      }

      // THE SCORE IS THE DEFECTS (owner, 2026-08-08). The eval prompts no
      // longer return a score — they return fixable_issues[], and every number
      // downstream is derived from it by the §2 rubric here. blendVisualScore
      // used to let the model's own number pull the result back UP
      // (max(computed, model − 3)), so an image the model felt good about
      // outranked what its own defect list justified.
      //
      // One of TWO severity→number tables that exist on purpose — see the note
      // above SEVERITY_POINTS in scoring.js. This one is the 0-10 scale used by
      // qualityScore + the repair-method gates; it never feeds finalScore.
      const SEVERITY_PENALTY = { CATASTROPHIC: 5, CRITICAL: 3, MAJOR: 2, MODERATE: 1, MINOR: 0.5 };
      const totalPenalty = fixableIssues.reduce(
        (sum, i) => sum + (SEVERITY_PENALTY[String(i.severity).toUpperCase()] ?? 1),
        0
      );
      const visualScore10 = Math.max(0, Math.min(10, 10 - totalPenalty));
      const score = visualScore10 * 10; // 0-100 for compatibility

      log.info(`📊 [EVAL] Score: ${visualScore10}/10 (${score}/100) from ${fixableIssues.length} defect(s), Verdict: ${verdict}`);
      const hasRealIssues = issuesSummary && issuesSummary !== 'none' && issuesSummary.toLowerCase() !== 'none';
      if (hasRealIssues) {
        log.info(`📊 [EVAL] Issues: ${issuesSummary}`);
      }

      // Also parse legacy fix_targets for backwards compatibility
      let jsonFixTargets = fixTargets;
      if (parsedJson.fix_targets && Array.isArray(parsedJson.fix_targets)) {
        jsonFixTargets = parsedJson.fix_targets
          .filter(t => t.bbox && Array.isArray(t.bbox) && t.bbox.length === 4)
          .map(t => ({
            boundingBox: t.bbox,
            issue: t.issue || 'unknown issue',
            fixPrompt: t.fix || 'fix the issue'
          }));
        if (jsonFixTargets.length > 0) {
          log.info(`📊 [EVAL] Parsed ${jsonFixTargets.length} fix targets from JSON (legacy format)`);
        }
      }

      // For covers, classify text issues by severity. The eval prompt's
      // TEXT RULES block above tells the model:
      //   - title missing/misspelled          → severity CATASTROPHIC
      //   - other prominent unrequested text  → severity MAJOR
      //   - small incidental signage          → not flagged (MINOR if garbled)
      // (CRITICAL matched too for evals stored before the graded-severity
      // change.) The buckets need different handling:
      //   TITLE_ERROR — full regen; no inpaint can paint a missing title.
      //   STRAY_TEXT  — flows through the normal repair path. Inpaint can
      //                 paint over the unwanted-text region instead of
      //                 trashing an otherwise-good cover and retrying.
      // Before this split, ANY cover text issue forced a full regen, which
      // wasted a generation every time a character incidentally held
      // anything written.
      let textIssue = null;
      if (evaluationType === 'cover' && Array.isArray(fixableIssues) && fixableIssues.length > 0) {
        const TEXT_RE = /\b(text|letter|word|sign|caption|label|spell|title|writing|inscription|misspell)/i;
        const textRelated = fixableIssues.filter(i =>
          i?.type === 'rendered_text' || TEXT_RE.test(i?.description || '')
        );
        if (textRelated.some(i => /catastrophic|critical/i.test(String(i?.severity || '')))) {
          textIssue = 'TITLE_ERROR';
        } else if (textRelated.length > 0) {
          textIssue = 'STRAY_TEXT';
        }
      }
      // Fallback for evaluators that didn't emit structured fixable_issues but
      // mentioned text in issuesSummary — assume worst case (title error) so
      // we don't ship a missing-title cover when the eval format drifts.
      if (textIssue === null && evaluationType === 'cover' && issuesSummary) {
        const issuesLower = issuesSummary.toLowerCase();
        if (issuesLower.includes('text') || issuesLower.includes('spell') || issuesLower.includes('letter')) {
          textIssue = 'TITLE_ERROR';
        }
      }

      // Store the FULL analysis JSON as reasoning (for dev mode display)
      // This includes subject_mapping, identity_sync, rendering_integrity, scene_check
      const reasoning = JSON.stringify(parsedJson, null, 2);

      // Extract figures and matches for character-aware bbox matching
      // figures: [{id, position, hair, clothing, action, view}]
      // matches: [{figure, reference (char name), confidence, face_bbox, issues}]
      let figures = parsedJson.figures || [];
      let matches = parsedJson.matches || [];
      // Boxes on both lists go through the same normaliser as the inventory:
      // a 0-1 box passes unchanged, Qwen's mixed 0-1000 values are rescaled.
      {
        const { normaliseInventoryBoxes } = require('./inventoryBoxes');
        const bs = normaliseInventoryBoxes({ figures: [...figures, ...matches] });
        if (bs.fixed || bs.dropped) log.info(`📊 [EVAL] ${modelId}: normalised ${bs.fixed} box(es) from 0-1000 scale, dropped ${bs.dropped} malformed`);
      }
      if (matches.length > 0) {
        log.info(`📊 [EVAL] Character matches: ${matches.map(m => `Figure ${m.figure} → ${m.reference} (${Math.round(m.confidence * 100)}%)`).join(', ')}`);
      }
      // THE PRESENCE SIGNAL (owner, 2026-09-13). Code does the arithmetic and
      // emits at most one outcome — see derivePresenceFinding. When it speaks,
      // it OWNS the pair: the evaluator's own missing/extra findings are
      // dropped first, so a page can never carry both at once. When it declines
      // (no detector count — covers today; witnesses disagreeing) the
      // evaluator's findings stand untouched, which is what keeps the surplus
      // detectable on the ~4 call sites that have no detector.
      // Hoisted: the three-stage and semantic lists merge in further down, and
      // they carry absence claims of their own. The two-witness filter this
      // replaced covered all four lists; so does this.
      let presenceDerived = false;
      {
        const presence = derivePresenceFinding({
          figures, matches, cast: expectedCast, detectedFigureCount: detectedPeopleCount,
          // Geometry for the ambient-background filter; only read on a page the
          // brief declared `population: "ambient"`.
          detectorFigures: Array.isArray(evalOptions.detectedFigures) ? evalOptions.detectedFigures : null,
          referenceNames: attachedReferenceNames,
          castIndex: castIdx,
        });
        const spoke = presence.outcome !== 'declined';
        presenceDerived = spoke;
        if (spoke) {
          const before = fixableIssues.length;
          fixableIssues = fixableIssues.filter(i => !PRESENCE_COUNT_TYPES.has(String(i?.type || '').toLowerCase()));
          const dropped = before - fixableIssues.length;
          if (presence.finding) fixableIssues.push(presence.finding);
          log.info(`👥 [PRESENCE] ${pageContext || 'page'}: ${detectedPeopleCount} person-figure(s) vs EXPECTED CAST ${expectedCast.count}`
            + `${expectedCast.nonHumanNames?.length ? ` (minus non-human ${expectedCast.nonHumanNames.join(', ')})` : ''}`
            + ` → ${presence.outcome}${presence.reason ? ` [${presence.reason}]` : ''}${presence.finding?.character ? ` (${presence.finding.character})` : ''}`
            + `${dropped ? `; dropped ${dropped} evaluator presence finding(s)` : ''}`);
        } else {
          log.info(`👥 [PRESENCE] ${pageContext || 'page'}: declined (${presence.reason})`
            + ` — detector people ${detectedPeopleCount ?? 'n/a'} (all figures ${realFigureCount ?? 'n/a'}),`
            + ` evaluator ${Array.isArray(figures) ? figures.length : 'n/a'}, roster ${expectedCast.count}`
            + `${expectedCast.nonHumanNames?.length ? ` incl. non-human ${expectedCast.nonHumanNames.join(', ')}` : ''}`);
        }
        try {
          // The id may be absent at an unthreaded call site; forJob() now rescues
          // it from the ambient run scope and warns rather than dropping it.
          require('./runMetrics').forJob(evalOptions?.storyMeta?.storyId)
            .count(presenceCounterName(presence, spoke));
        } catch { /* metrics are best-effort */ }
      }

      // Merge P1 figure data if available (better age detection — P1 doesn't see the prompt)
      let p1Usage = null;
      if (p1Promise) {
        try {
          const p1Result = await p1Promise;
          if (p1Result) {
            // P1 contributes the FIGURE INVENTORY only. Identity is not P1's to
            // decide and never was: P1 is prompt-blind by design, so it has no
            // character descriptions, no clothing contract and no declared
            // positions — the three things identity actually rests on. Asked to
            // name people from a photo-vs-watercolour resemblance alone, it
            // answered "UNMATCHED" with confidence 0 and, because a junk array
            // is still a non-empty array, that answer replaced the evaluator's.
            // Measured across two production stories: 12 versions where the
            // evaluator had named every character at 0.85-0.90 stored
            // `unmatched` / `No reference provided` instead, and every
            // per-character check downstream — clothing, action, scale — reads a
            // NAME, so all of them went silent on those pages.
            // (An earlier fix here made the override conditional on a non-empty
            // array; the array was never the problem, the ownership was.)
            //
            // figures[] and matches[] must come from ONE producer. `figure` ids
            // are only meaningful inside the list that issued them, and the two
            // producers number differently (figureIdentityCheck.js documents P1
            // seeing 5 figures on a page where the evaluator's parse saw 3).
            // Taking P1's inventory next to the evaluator's matches would make
            // every `match.figure` point into the wrong list. So P1's inventory
            // is used only where the evaluator named nobody — there is no pair
            // to break, and an honest figure list still beats none.
            if (p1Result.figures?.length && matches.length === 0) figures = p1Result.figures;
            p1Usage = { inputTokens: p1Result.inputTokens, outputTokens: p1Result.outputTokens };
          }
        } catch (e) {
          log.warn(`⚠️ [QUALITY P1] Figure check failed: ${e.message}`);
        }
      }

      // A page whose figures nobody named is a page where every per-character
      // check goes quiet — clothing, action and scale all key off a name. It
      // used to pass silently: measured on one production story, the evaluator
      // returned figures and an empty `matches` on 21 of 30 versions and nothing
      // said so. Countable, not just scrollback.
      if (figures.length > 0 && matches.length === 0) {
        log.warn(`⚠️ [EVAL] ${pageContext}: ${figures.length} figure(s) and ZERO matches — no per-character finding can name anyone on this page`);
        try {
          require('./runMetrics').forJob(evalOptions?.storyMeta?.storyId).count('eval_matches_missing');
        } catch { /* metrics are best-effort */ }
      }

      // Release quality figures/matches to three-stage Stage 2
      if (qualityFiguresResolve) {
        qualityFiguresResolve({ figures, matches });
      }

      // Await semantic evaluation if running in parallel
      let semanticResult = null;
      let finalScore = score;
      let combinedIssuesSummary = issuesSummary;
      if (semanticPromise) {
        try {
          semanticResult = await semanticPromise;
          // ONE PRESENCE SIGNAL PER PAGE — same rule as the three-stage merge
          // below. The semantic judge's vocabulary includes missing_character
          // and it is scored on its own table, so an unfiltered absence here
          // would rebuild the very pair the derivation exists to prevent.
          if (presenceDerived && Array.isArray(semanticResult?.semanticIssues)) {
            const kept = semanticResult.semanticIssues.filter(i => !PRESENCE_COUNT_TYPES.has(String(i?.type || i?.subType || '').toLowerCase()));
            if (kept.length !== semanticResult.semanticIssues.length) {
              log.info(`👥 [PRESENCE] ${pageContext || 'page'}: ${semanticResult.semanticIssues.length - kept.length} semantic presence finding(s) superseded by the derivation`);
              semanticResult.semanticIssues = kept;
            }
          }
          if (semanticResult && semanticResult.semanticIssues && semanticResult.semanticIssues.length > 0) {
            // Semantic surcharge via the ONE shared table (scoring.js
            // SEMANTIC_ISSUE_PENALTY): the hand-copied chain here billed
            // CATASTROPHIC 10 (the `else` arm) — half of MAJOR. Lazy require
            // per the cycle law in this file's header.
            const semanticPenalty = require('./scoring').semanticPenaltyPoints(semanticResult.semanticIssues);
            finalScore = score - semanticPenalty;  // no 0-floor: see scoring.js computeMathFinalScore
            log.info(`🔍 [SEMANTIC] Semantic score: ${semanticResult.score}/100, penalty: ${semanticPenalty} points (quality ${score} → final ${finalScore})`);
            // Append semantic issues to summary
            const semanticSummary = semanticResult.semanticIssues.map(i => require('./scoring').findingText(i)).join('; ');
            combinedIssuesSummary = issuesSummary
              ? `${issuesSummary}; SEMANTIC: ${semanticSummary}`
              : `SEMANTIC: ${semanticSummary}`;
          }
        } catch (semanticErr) {
          log.warn(`[SEMANTIC] Parallel evaluation failed: ${semanticErr.message}`);
        }
      }

      // Await three-stage eval. Always merge its fixableIssues into the
      // visible list (the dev panel shows the full set). Then RECOMPUTE the
      // visual quality score from the full merged fixable_issues array using
      // the same §2 rubric — otherwise three-stage findings show up in the
      // UI but never influence the threshold gate that triggers repair
      // (observed on page 5 of job_1777325711738_d5brbvvx3: main eval
      // emitted 1 MINOR → score 95, three-stage added 2 MODERATE + 1 MINOR
      // composition issues, merged into the display array but NOT into the
      // score → page stayed at qualityScore 85, above the 80 threshold,
      // never repaired despite -30 worth of real visual defects).
      let threeStageResult = null;
      let visualScore = score; // Quality score AFTER any three-stage merge
      if (threeStagePromise) {
        try {
          threeStageResult = await threeStagePromise;
          if (threeStageResult?.evalFailed) {
            // Truncated compliance reply (evaluateThreeStage): no findings are
            // merged, the quality verdict stands, and the failure rides along
            // in `threeStageResult` so it never reads as "compliance found nothing".
            log.warn(`⚠️ [THREE-STAGE] ${pageContext ? `[${pageContext}] ` : ''}${threeStageResult.evalError}`);
          } else if (threeStageResult?.fixableIssues?.length) {
            // ONE PRESENCE SIGNAL PER PAGE. When the arithmetic has spoken it
            // owns the pair across every judge, not just the quality one — the
            // blind compliance judge's "not identified in matches[]" absence is
            // exactly the inference the detector count already answered.
            //
            // FILTER THE RECORD, NOT A COPY (2026-09-14). This used to prune a
            // local `incoming` array on its way into the merged list, and the
            // finding survived verbatim on `threeStageResult` — which is the
            // object scoring.js reads for the compliance bucket
            // (`evalResult.threeStageResult.fixableIssues`, and again for
            // `scoreBreakdown.threeStage.issues`), so the superseded finding
            // still reached `consolidatedPlan.deduped_issues` and the repair
            // pipeline. Measured: a page whose `missing_character` WAS dropped
            // from the version's own fixableIssues and still appeared in its
            // consolidated plan. Both the mapped list and the judge's raw
            // `complianceResult.fixable_issues` are pruned in place.
            if (presenceDerived) {
              const skipped = supersedePresenceFindings(threeStageResult);
              if (skipped) log.info(`👥 [PRESENCE] ${pageContext || 'page'}: ${skipped} three-stage presence finding(s) superseded by the derivation`);
            }
            fixableIssues = [...fixableIssues, ...threeStageResult.fixableIssues];
          }
          if (threeStageResult?.issuesSummary) {
            combinedIssuesSummary = combinedIssuesSummary
              ? `${combinedIssuesSummary}; THREE-STAGE: ${threeStageResult.issuesSummary}`
              : `THREE-STAGE: ${threeStageResult.issuesSummary}`;
          }
        } catch (tsErr) {
          log.warn(`[THREE-STAGE] Parallel evaluation failed: ${tsErr.message}`);
        }
      }

      // THE SCORE DERIVES FROM THE CURRENT ISSUE LIST — recomputed here, once,
      // over whatever `fixableIssues` finally holds. It used to be recomputed
      // only inside the three-stage merge branch, which was fine while that
      // branch was the only thing that could change the list after the first
      // computation at `score`. The presence derivation now also adds and
      // removes entries, so a page with no three-stage findings would have
      // carried a derived CRITICAL that cost nothing. Same rubric, same shared
      // semantic table; with nothing added this reproduces `score` exactly.
      {
        const mergedPenalty = fixableIssues.reduce(
          (sum, i) => sum + (SEVERITY_PENALTY[String(i.severity).toUpperCase()] ?? 1),
          0
        );
        const recomputed = Math.max(0, Math.min(10, 10 - mergedPenalty)) * 10;
        const semanticPenalty = require('./scoring').semanticPenaltyPoints(semanticResult?.semanticIssues);
        if (recomputed !== visualScore) {
          log.info(`📊 [EVAL] ${pageContext ? `[${pageContext}] ` : ''}Recomputed visual ${visualScore}→${recomputed} from ${fixableIssues.length} finding(s), final ${recomputed - semanticPenalty} (semantic −${semanticPenalty})`);
        }
        visualScore = recomputed;
        finalScore = visualScore - semanticPenalty;  // no 0-floor: see scoring.js computeMathFinalScore
      }

      // Aggregate usage from quality + P1 + semantic + three-stage evaluations
      const semanticUsage = semanticResult?.usage || {};
      const threeStageUsage = threeStageResult?.usage || {};
      const totalUsage = {
        input_tokens: qualityInputTokens + (p1Usage?.inputTokens || 0) + (semanticUsage.input_tokens || 0) + (threeStageUsage.threeStage_input_tokens || 0),
        output_tokens: qualityOutputTokens + (p1Usage?.outputTokens || 0) + (semanticUsage.output_tokens || 0) + (threeStageUsage.threeStage_output_tokens || 0),
        thinking_tokens: qualityThinkingTokens,
        p1_input_tokens: p1Usage?.inputTokens || 0,
        p1_output_tokens: p1Usage?.outputTokens || 0,
        semantic_input_tokens: semanticUsage.input_tokens || 0,
        semantic_output_tokens: semanticUsage.output_tokens || 0,
        threeStage_input_tokens: threeStageUsage.threeStage_input_tokens || 0,
        threeStage_output_tokens: threeStageUsage.threeStage_output_tokens || 0
      };

      // SCORE NAMING CONVENTION (counterintuitive but intentional):
      // - score:        FINAL penalized score = visual - semantic - entity - three-stage penalties. Used for redo decisions.
      // - qualityScore: RAW visual quality score from Gemini eval only (before any penalties).
      // - semanticScore: Separate semantic fidelity score (0-100, null if not evaluated).
      // - threeStageScore: Separate three-stage compliance score (0-100, null if not evaluated).
      // When writing to scene.qualityScore in DB, use evaluation.qualityScore (NOT evaluation.score).
      return {
        // Dimensions that went UNJUDGED on this image, own + the compliance
        // judge's. Never a deduction: `score` above is computed exactly as it
        // was before this field existed (owner decision 2026-09-14 — scoring
        // left as-is). `[]` means everything the check offers was judged.
        notEvaluated: [...notEvaluated.list(), ...(threeStageResult?.notEvaluated || [])],
        score: finalScore,                    // Combined final score (visual − semantic)
        qualityScore: visualScore,            // Visual quality score AFTER three-stage merge
        semanticScore: semanticResult?.score ?? null,  // Semantic fidelity score (0-100)
        threeStageScore: threeStageResult?.score ?? null, // Three-stage compliance score (0-100)
        visualScore10, // 0-10 defect-derived visual score, BEFORE the three-stage merge (audit)
        verdict,
        reasoning,
        rawOutput: responseText,              // Full unparsed API response (for dev testing)
        evalTemplateHash,                     // Template version that produced this score
        issuesSummary: combinedIssuesSummary,
        textIssue,
        fixTargets: jsonFixTargets,       // Legacy format with bboxes (backwards compat)
        // PROVENANCE (2026-09-14). ONE stamp, at the point the page's merged
        // list is finalised, so it covers every branch that reached it: the
        // evaluator's own `fixable_issues`, the coherence and style gates
        // authored above, and the multi-judge jury rebuild (which reconstructs
        // the list from bucket vectors and would have dropped a stamp made
        // earlier). `stampFindingSource` never overwrites, so the three-stage
        // compliance findings merged in above keep `compliance` and the
        // presence derivation keeps `final_checks`; only the quality judge's
        // own findings are filled in here.
        fixableIssues: stampFindingSource(Array.isArray(fixableIssues) ? fixableIssues : [], FINDING_SOURCES.QUALITY),  // always an array — eliminates downstream null-checks
        figures,                          // Detected figures with descriptions
        matches,                          // Character name → figure mapping with face_bbox
        coherenceGate,                    // STEP 0 gate {applied, reason} — drives the forced redo above
        // STYLE GATE {observed, matches_style, reason}. Returned so it is
        // auditable: without this the gate was a local variable that pushed a
        // finding and vanished, so across two full stories there was no way to
        // tell whether the model had answered it, answered it wrongly, or never
        // emitted the field at all. A gate you cannot inspect is not a gate.
        styleGate,
        semanticResult,                   // Full semantic evaluation result (if available)
        threeStageResult,                 // Full three-stage evaluation result (if available)
        usage: totalUsage,
        modelId: modelId
      };
    }

    // Helper to merge semantic + P1 results into quality result (used by fallback text-format parsers)
    const mergeSemanticResult = async (qualityScore, reasoning) => {
      let semanticResult = null;
      let finalScore = qualityScore;
      let issuesSummary = '';

      // Await P1 for figure data (best-effort)
      let p1Usage = null;
      if (p1Promise) {
        try {
          const p1Result = await p1Promise;
          if (p1Result) {
            p1Usage = { inputTokens: p1Result.inputTokens, outputTokens: p1Result.outputTokens };
          }
        } catch (e) { /* already logged */ }
      }

      if (semanticPromise) {
        try {
          semanticResult = await semanticPromise;
          if (semanticResult && semanticResult.semanticIssues && semanticResult.semanticIssues.length > 0) {
            // Shared table (scoring.js semanticPenaltyPoints) — same reason as
            // the parsed-JSON chain: the hand-copy billed CATASTROPHIC 10.
            const semanticPenalty = require('./scoring').semanticPenaltyPoints(semanticResult.semanticIssues);
            finalScore = qualityScore - semanticPenalty;  // no 0-floor: see scoring.js computeMathFinalScore
            log.info(`🔍 [SEMANTIC] Applied ${semanticPenalty} point penalty for semantic issues (${qualityScore} → ${finalScore})`);
            issuesSummary = `SEMANTIC: ${semanticResult.semanticIssues.map(i => require('./scoring').findingText(i)).join('; ')}`;
          }
        } catch (semanticErr) {
          log.warn(`[SEMANTIC] Parallel evaluation failed: ${semanticErr.message}`);
        }
      }

      // Await three-stage eval and merge (use lower score)
      let threeStageResult = null;
      if (threeStagePromise) {
        try {
          threeStageResult = await threeStagePromise;
          if (threeStageResult && threeStageResult.evalFailed) {
            // Truncated compliance reply (see evaluateThreeStage): the quality
            // verdict stands, but the page is stamped so the failure is visible
            // and never reads as "compliance found nothing".
            log.warn(`⚠️ [THREE-STAGE] ${pageContext ? `[${pageContext}] ` : ''}${threeStageResult.evalError}`);
          } else if (threeStageResult && threeStageResult.score < finalScore) {
            log.info(`📊 [THREE-STAGE] ${pageContext ? `[${pageContext}] ` : ''}Score ${threeStageResult.score} < quality ${finalScore} — using three-stage score`);
            finalScore = threeStageResult.score;
            issuesSummary = threeStageResult.issuesSummary
              ? (issuesSummary ? `${issuesSummary}; THREE-STAGE: ${threeStageResult.issuesSummary}` : `THREE-STAGE: ${threeStageResult.issuesSummary}`)
              : issuesSummary;
          } else if (threeStageResult) {
            log.info(`📊 [THREE-STAGE] ${pageContext ? `[${pageContext}] ` : ''}Score ${threeStageResult.score} >= quality ${finalScore} — keeping quality score`);
          }
        } catch (tsErr) {
          log.warn(`[THREE-STAGE] Parallel evaluation failed: ${tsErr.message}`);
        }
      }

      // Aggregate usage
      const semanticUsage = semanticResult?.usage || {};
      const threeStageUsage = threeStageResult?.usage || {};
      const totalUsage = {
        input_tokens: qualityInputTokens + (p1Usage?.inputTokens || 0) + (semanticUsage.input_tokens || 0) + (threeStageUsage.threeStage_input_tokens || 0),
        output_tokens: qualityOutputTokens + (p1Usage?.outputTokens || 0) + (semanticUsage.output_tokens || 0) + (threeStageUsage.threeStage_output_tokens || 0),
        thinking_tokens: qualityThinkingTokens,
        p1_input_tokens: p1Usage?.inputTokens || 0,
        p1_output_tokens: p1Usage?.outputTokens || 0,
        semantic_input_tokens: semanticUsage.input_tokens || 0,
        semantic_output_tokens: semanticUsage.output_tokens || 0,
        threeStage_input_tokens: threeStageUsage.threeStage_input_tokens || 0,
        threeStage_output_tokens: threeStageUsage.threeStage_output_tokens || 0
      };

      return {
        // Dimensions that went UNJUDGED on this image, own + the compliance
        // judge's. Never a deduction: `score` above is computed exactly as it
        // was before this field existed (owner decision 2026-09-14 — scoring
        // left as-is). `[]` means everything the check offers was judged.
        notEvaluated: [...notEvaluated.list(), ...(threeStageResult?.notEvaluated || [])],
        score: finalScore,                    // Combined final score
        qualityScore: qualityScore,           // Visual quality score only
        semanticScore: semanticResult?.score ?? null,  // Semantic fidelity score (0-100)
        threeStageScore: threeStageResult?.score ?? null, // Three-stage compliance score (0-100)
        reasoning,
        rawOutput: responseText,              // Full unparsed API response
        evalTemplateHash,                     // Template version that produced this score
        issuesSummary,
        fixTargets,
        semanticResult,
        threeStageResult,
        usage: totalUsage,
        modelId: modelId
      };
    };

    // Parse "Score: X/10" format (new simplified format)
    const score10Match = responseText.match(/Score:\s*(\d+)\/10\b/i);
    if (score10Match) {
      const visualScore10 = parseInt(score10Match[1]);
      const qualityScore = visualScore10 * 10; // legacy text format; new prompts emit no score
      log.verbose(`📊 [EVAL] Image quality score: ${visualScore10}/10 (${qualityScore}/100)`);
      return mergeSemanticResult(qualityScore, responseText);
    }

    // Fallback: Parse legacy format "Score: XX/100"
    const scoreMatch = responseText.match(/Score:\s*(\d+)\/100/i);
    if (scoreMatch) {
      const qualityScore = parseInt(scoreMatch[1]);
      log.verbose(`📊 [EVAL] Image quality score: ${qualityScore}/100 (legacy format)`);
      return mergeSemanticResult(qualityScore, responseText);
    }

    // Fallback: Try parsing just a number (0-100)
    const numericScore = parseFloat(responseText);
    if (!isNaN(numericScore) && numericScore >= 0 && numericScore <= 100) {
      log.verbose(`📊 [EVAL] Image quality score: ${numericScore}/100 (numeric format)`);
      return mergeSemanticResult(numericScore, responseText);
    }

    log.warn(`⚠️  [QUALITY] Response is neither a defect report nor a legacy score (finishReason=${finishReason}, ${responseText.length} chars):`, responseText.substring(0, 200));
    // Await parallel promises to prevent memory leak
    if (p1Promise) await p1Promise.catch(() => {});
    if (semanticPromise) await semanticPromise.catch(() => {});
    if (threeStagePromise) await threeStagePromise.catch(() => {});
    return null;
  } catch (error) {
    log.error('❌ [QUALITY] Error evaluating image quality:', error);
    // Await parallel promises to prevent memory leak
    if (p1Promise) await p1Promise.catch(() => {});
    if (semanticPromise) await semanticPromise.catch(() => {});
    if (threeStagePromise) await threeStagePromise.catch(() => {});
    return null;
  } finally {
    // Always release three-stage Stage 2 so it doesn't hang on any early return.
    // Safe to call twice — promises ignore subsequent resolve() calls.
    if (qualityFiguresResolve) qualityFiguresResolve(null);
  }
}

module.exports = {
  presenceCounterName,
  runVisualInventory,
  validateEmptyScene,
  buildEmptySceneQcPrompt,
  largestInteriorUniformFraction,
  capComplianceIdentitySeverity,
  evaluateThreeStage,
  sanitizeForGemini,
  evaluateImageQuality,
  buildEvalClothingContract,
  buildEvalRequiredObjects,
  buildExpectedCastBlock,
  vbCellReferencesForCast,
  resolveExpectedCastNames,
  reconcileDetectorCast,
  parseFixableIssues,
  derivePresenceFinding,
  supersedePresenceFindings,
  PRESENCE_DERIVED_MARKER,
  PRESENCE_COUNT_TYPES,
  IMAGE_QUALITY_THRESHOLD,
};
