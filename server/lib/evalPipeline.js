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
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { MODEL_DEFAULTS, withRetry } = require('./textModels');
const { TEXT_MODELS, REPAIR_DEFAULTS } = require('../config/models');
const r2Lib = require('./r2');

// storyHelpers functions (lazy-loaded to avoid circular dependencies)
let storyHelpersModule = null;
function getStoryHelpers() {
  if (!storyHelpersModule) {
    storyHelpersModule = require('./storyHelpers');
  }
  return storyHelpersModule;
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
const EVAL_THINKING_BUDGET = process.env.EVAL_THINKING_BUDGET != null ? Number(process.env.EVAL_THINKING_BUDGET) : 0;

// Quality threshold from environment or default
const IMAGE_QUALITY_THRESHOLD = parseFloat(process.env.IMAGE_QUALITY_THRESHOLD) || REPAIR_DEFAULTS.scoreThreshold;

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

    // Route to Grok vision API for xAI models
    const modelConfig = TEXT_MODELS[modelId];
    let p1Response;
    if (modelConfig?.provider === 'xai') {
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
            generationConfig: {
              maxOutputTokens: 32000,
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
        const grokFallbackId = 'grok-4-fast';
        const grokFallbackModel = TEXT_MODELS[grokFallbackId];
        if (grokFallbackModel?.provider === 'xai') {
          log.info(`🔄 [QUALITY P1] ${pageLabel}Falling back to Grok vision (${grokFallbackId}) after HTTP error...`);
          try {
            const grokResp = await require('./images').callGrokVisionAPI(grokFallbackId, grokFallbackModel.modelId || grokFallbackId, inventoryParts, inventoryPrompt);
            if (grokResp.ok) {
              p1Response = grokResp;
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

    const p1Blocked = p1Data.promptFeedback?.blockReason ||
      !p1Data.candidates || p1Data.candidates.length === 0 ||
      p1Data.candidates[0]?.finishReason === 'SAFETY' ||
      p1Data.candidates[0]?.finishReason === 'PROHIBITED_CONTENT';

    if (p1Blocked) {
      const pageLabel = pageContext ? `[${pageContext}] ` : '';
      log.warn(`⚠️ [QUALITY P1] ${pageLabel}Content blocked by Gemini safety`);
      // Fall back to Grok vision if we weren't already using xAI
      if (modelConfig?.provider !== 'xai') {
        const grokFallbackId = 'grok-4-fast';
        const grokFallbackModel = TEXT_MODELS[grokFallbackId];
        if (grokFallbackModel?.provider === 'xai') {
          log.info(`🔄 [QUALITY P1] ${pageLabel}Falling back to Grok vision (${grokFallbackId})...`);
          try {
            const grokResp = await require('./images').callGrokVisionAPI(grokFallbackId, grokFallbackModel.modelId || grokFallbackId, inventoryParts, inventoryPrompt);
            if (grokResp.ok) {
              p1Data = await grokResp.json();
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

    if (opts.raw) return { rawText: p1Text, inputTokens, outputTokens };

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

    const thinkingInfo = thinkingTokens > 0 ? `, thinking: ${thinkingTokens.toLocaleString()}` : '';
    log.verbose(`📊 [EVAL P1] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}${thinkingInfo}`);

    const figures = inventoryJson.figures || [];
    if (figures.length > 0) {
      log.info(`📊 [EVAL P1] Figures: ${figures.map(f => `#${f.id} ${f.hair} (${f.position})`).join('; ')}`);
    }

    return {
      figures,
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
    let whiteBoxBlocks = 0;
    let blackBoxBlocks = 0;
    for (let i = 0; i < rows * cols; i++) {
      if (blockBrightness[i] > 240 && blockVariance[i] < 5) whiteBoxBlocks++;
      if (blockBrightness[i] < 15 && blockVariance[i] < 5) blackBoxBlocks++;
    }
    const whiteBoxPct = whiteBoxBlocks / (rows * cols);
    const blackBoxPct = blackBoxBlocks / (rows * cols);
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
          const placementsCheck = placementsBlock
            ? `\n4. Given the character placements above, does the empty scene have open, flat, usable ground at EACH of those frame positions? FAIL if a character position (e.g. "far-left background") maps to a frame region that is blocked by a wall, a building facade, a large prop, or the very edge of a receding corridor. Name the blocked position in the issue.`
            : '';
          // Composition geometry fidelity — the main scene will composite characters,
          // aim lines, and distant targets onto this empty scene. If the path
          // direction, vanishing point, or reserved distant-target spot in the
          // empty scene doesn't match what the main scene prose describes, the
          // composite will be broken (e.g. character aims toward a target corner
          // where the empty scene has a wall instead of an opening).
          const mainSceneBlock = mainScenePrompt
            ? `\n\nMAIN SCENE PROSE (what will be composited onto this empty scene):\n"${mainScenePrompt.substring(0, 800)}"`
            : '';
          const geometryCheck = mainScenePrompt
            ? `\n5. Composition geometry — does this empty scene support the main scene's geometry? Check:
   a. Any path, river, road, corridor, shoreline, horizon, or major perspective line — does it run in the same direction the main scene prose describes (e.g. "stretches to the right background", "diagonal from lower-left to upper-right")?
   b. Vanishing point / opening location — is it at the frame position the main scene implies (e.g. main scene says "sliver of light at far right background" → empty scene must have that opening/light at the upper-right, not centered or on the left)?
   c. Reserved open space for distant composited targets — if the main scene places a "tiny figure" or small object at a specific corner, the empty scene must have open, uncluttered sky/ground/path there, not a wall or tree trunk.
   d. Lighting direction — consistent with the main scene's time of day and declared light source.
   FAIL with a specific fix instruction if any of (a)–(d) disagree. The issue description must name WHAT geometry is wrong AND the corrected direction/position. Example: "path runs front-to-center instead of diagonally to the upper-right; regenerate with the path angled toward the upper-right corner where the target will be composited".`
            : '';

          const visionUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
          const visionResp = await fetch(visionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [
                { inline_data: { mime_type: mimeType, data: base64ForVision } },
                { text: `This is a background scene for a children's book illustration. Small background figures, animals, and distant people are fine — they add life to the scene.${sceneCtx}${eraBlock}${placementsBlock}${mainSceneBlock}

Check:
- Setting / location: does it roughly match the expected scene? (FAIL if completely wrong location — e.g. expected a forest but got a city)
- Naturalness: does the image look like a natural, plausible illustration of the scene? Or are there strange artefacts, geometry that doesn't make sense, doubled props, melted shapes, surfaces that change material mid-stroke, perspective lines that contradict each other, or anything that looks "off" for a competent painter? (FAIL — describe what looks unnatural)
- Geometric artefact patches: are there large artificial-looking patches — white or near-white **rectangles, triangles, diagonals, wedges, or any solid geometric shape**, monochrome panels, blank patches, or obvious AI glitches that cover a meaningful portion of the frame? Pay special attention to bright triangular or diagonal cutouts that don't belong to the scene's geometry. (FAIL — name the shape and where it is)
- Foreground space: is there visible open space in the foreground where main characters could be placed later? (FAIL if the entire foreground is filled with objects or walls)
- Unrequested text or signage: does the image contain readable text, letters, numbers, shop signs, banners, posters, logos, labels, or written inscriptions that are NOT named in the expected scene? (FAIL — name where the text appears. A pub sign, street sign, poster text, or any inscription not explicitly requested counts. Distant painted banners with no readable text are OK.)${storyEra ? `
- Anachronistic elements for the stated STORY ERA above: are there objects that don't fit the period? (FAIL — name them. Cars, parked vehicles, modern street lights, traffic signs, billboards, power lines, utility poles, satellite dishes, air conditioners, modern shopfront windows with price stickers, commercial ads, plastic bins, painted crosswalks, road markings, telephone poles, fire hydrants. Skip this check only if the story era is "present-day" or "modern".)` : ''}${placementsCheck}${geometryCheck}

Reply JSON only: {"pass": true/false, "issues": ["short issue"], "feedback": "one sentence naming WHAT to remove or fix — e.g. 'remove the pub sign at upper-left and the parked car at lower-right'. Be specific enough that a regeneration prompt can target the named elements."}` }
              ]}],
              generationConfig: { maxOutputTokens: 350, temperature: 0.1, responseMimeType: 'application/json' },
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
  } = options;
  const pageLabel = pageContext ? `[${pageContext}] ` : '';

  // No vision template here any more: Stage 1 is the shared blind inventory,
  // produced by the single call in evaluateImageQuality and handed in.
  const complianceTemplate = compliancePromptOverride || PROMPT_TEMPLATES.imagePromptCompliance;

  if (!complianceTemplate) {
    log.warn(`[THREE-STAGE] ${pageLabel}Compliance template not loaded, skipping`);
    return null;
  }

  // Extract interactions from sceneHint for Stage 2
  let interactionsBlock = '(none declared)';
  try {
    const { extractSceneMetadata } = getStoryHelpers();
    const meta = extractSceneMetadata(sceneHint || imagePrompt);
    const interactions = meta?.interactions
      || (Array.isArray(meta?.fullData?.interactions) ? meta.fullData.interactions : null);
    if (interactions && interactions.length > 0) {
      interactionsBlock = interactions
        .map(i => `- ${i.character || '?'} + ${i.object || '?'}: ${i.where || '(no placement given)'}`)
        .join('\n');
    }
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
    if (qualityFiguresPromise) {
      try {
        const qf = await qualityFiguresPromise;
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

    const complianceInput = fillTemplate(complianceTemplate, {
      ORIGINAL_PROMPT: (imagePrompt || '').substring(0, 3000),
      // Passed separately: ORIGINAL_PROMPT is truncated at 3000 chars and the
      // ART STYLE and CLOTHING blocks can sit past the cut, so the compliance
      // judge never saw them and treated required style/costume elements as
      // unrequested additions (a steampunk cover's goggles drew a CRITICAL).
      ART_STYLE: artStyle || require('../services/prompts').extractArtStyle(imagePrompt),
      CLOTHING_CONTRACT: clothingContract || '',
      EXPECTED_AGES: expectedAges || '',
      VISUAL_INVENTORY: visionText,
      QUALITY_FIGURES: qualityFiguresBlock,
      INTERACTIONS_BLOCK: interactionsBlock,
      STORY_TEXT: (storyText || '(not provided)').substring(0, 2000)
    });

    const { callTextModel } = require('./textModels');
    // Stage 2 was Sonnet — Haiku didn't reliably follow the "ignore prose
    // decoration unless it's a DECLARED INTERACTION" rule and kept flagging
    // false-positive gaze/facing issues that drove pointless repair rounds.
    // Now configurable (resolveEvalModel, key-guarded to sonnet). NOTE: this is
    // quality-critical and NOT yet A/B-validated on Qwen — watch repair churn.
    const complianceModel = complianceModelOverride || require('../config/models').resolveComplianceModel();
    const sonnetResult = await callTextModel(complianceInput, 8192, complianceModel, { usageLabel: 'semantic_compliance', temperature: EVAL_TEMPERATURE });

    stage2Usage = {
      input_tokens: sonnetResult.usage?.input_tokens || 0,
      output_tokens: sonnetResult.usage?.output_tokens || 0
    };

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
  if (Array.isArray(complianceResult.fixable_issues)) {
    fixableIssues = complianceResult.fixable_issues
      .filter(i => i.description)
      .map(i => ({
        description: i.description,
        severity: i.severity || 'MODERATE',
        type: i.type || 'default',
        fix: i.fix || `Fix: ${i.description}`,
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
        source: 'three-stage'
      }));
    // Never-CRITICAL gate on identity-absence findings (see helper above):
    // presence is an INPUT to this blind judge, never its judgment.
    capComplianceIdentitySeverity(fixableIssues);
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
    issuesSummary,
    fixableIssues,
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

// Helper function to check if a Gemini response indicates blocked content
const isBlockedResponse = (responseData) => {
  // Check promptFeedback for block reason
  if (responseData.promptFeedback?.blockReason) {
    return true;
  }
  // Check if no candidates due to safety
  if (!responseData.candidates || responseData.candidates.length === 0) {
    return true;
  }
  // Check candidate-level blocking
  const finishReason = responseData.candidates[0]?.finishReason;
  if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
    return true;
  }
  return false;
};

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
  try {
    // Guard against undefined/invalid imageData
    if (!imageData || typeof imageData !== 'string') {
      log.warn(`⚠️ [QUALITY] Invalid imageData passed to evaluateImageQuality: ${typeof imageData}`);
      return null;
    }

    // Strip scene description to relevant parts (remove Art Director checks, corrections, preview mismatches)
    // This reduces prompt size significantly and focuses the model on actual scene content
    if (originalPrompt && (originalPrompt.includes('"previewMismatches"') || originalPrompt.includes('"checks"'))) {
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
    const fidelityRef = storyText || (isCover && sceneHint ? sceneHint + coverEvalNote : null);
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
    let clothingContractBlock = '';
    try {
      const lines = [];
      const reqs = evalOptions.clothingRequirements || null;
      if (reqs) {
        const { buildClothingDescription } = require('./entityConsistency');
        for (const c of (sceneCharacters || [])) {
          if (!c?.name) continue;
          const category = reqs[c.name]?._currentClothing;
          if (!category) continue;
          const outfit = buildClothingDescription(c, category, artStyleForEval, reqs);
          if (outfit && String(outfit).trim()) lines.push(`- ${c.name}: ${String(outfit).trim()}`);
        }
      }
      if (lines.length === 0) {
        for (const p of (referenceImages || [])) {
          if (p?.name && p?.clothingDescription) lines.push(`- ${p.name}: ${String(p.clothingDescription).trim()}`);
        }
      }
      clothingContractBlock = lines.join('\n');
      if (!clothingContractBlock && (evaluationType === 'scene' || evaluationType === 'cover')) {
        // Loud, because an empty contract is what let the judge invent one.
        // Covers included: the 'scene'-only gate hid exactly the cover case
        // where an empty contract let the judge strip a requested costume.
        log.warn(`👕 [EVAL] ${pageContext || 'page'}: no clothing contract available — clothing findings suppressed (N-16)`);
      }
    } catch (err) { log.debug(`[EVAL] clothing contract block skipped: ${err.message}`); }

    // Start semantic evaluation in parallel when we have a reference (page prose
    // or cover brief).
    if (runFidelity) {
      const { evaluateSemanticFidelity } = require('./sceneValidator');
      semanticPromise = evaluateSemanticFidelity(imageData, fidelityRef, originalPrompt, sceneHint, evalOptions.semanticTemplateOverride || null, {
        artStyle: artStyleForEval,
        clothingContract: clothingContractBlock,
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
          qualityModelOverride || MODEL_DEFAULTS.qualityEval || 'gemini-2.5-flash',
          process.env.GEMINI_API_KEY, pageContext
        );
        log.debug(`📊 [EVAL P1] Shared blind inventory launched for ${pageContext || 'scene'}`);
      }
      qualityFiguresPromise = new Promise((resolve) => { qualityFiguresResolve = resolve; });
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
      });
      log.debug(`📊 [QUALITY] Starting parallel three-stage evaluation`);
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

      // Cover portraits: viewer-gaze and a flat title are intended, not defects.
      promptForEval = `COVER NOTE: a book-cover portrait. Do not deduct for characters facing or looking at the viewer, or for the title being flat 2D rather than three-dimensional.\n\n${promptForEval}`;

      if (textMode === 'appOverlay') {
        // Mode B: art is textless; title/dedication/branding composited by the
        // app after persistence. Was previously appended to the pseudo-page's
        // sceneDescription as string surgery (server.js pipeline entry).
        promptForEval = `TEXT NOTE: The title, dedication, and "magicalstory.ch" branding on this cover are handled by the app as a typographic overlay, not painted by the image model. Never flag missing/absent title/dedication/branding text as a defect, and if such text IS present treat it as the intended app-composited overlay — never flag it as unrequested rendered text.\n\n${promptForEval}`;
      } else if (expectedText) {
        promptForEval = `⚠️ TEXT RULES FOR THIS IMAGE:\nAllowed text: "${expectedText}" — and nothing else prominent.\nSeverities for text issues:\n- Allowed text missing or misspelled (any character difference) → severity: CATASTROPHIC.\n- Other prominent unrequested text on the cover (labels, captions, watermarks, extra words) → severity: MAJOR.\n- Small incidental in-world signage in the background → do not flag; if garbled → severity: MINOR.\nIf the only text on the image is exactly the allowed text, evaluate normally.\n\nBefore reporting a title misspelling, RE-READ the rendered text letter-by-letter against the allowed text above. Report a mismatch ONLY if you can quote the exact rendered string and it differs from the allowed text. If you are uncertain whether the rendering matches, do NOT flag it.\n\n${promptForEval}`;
      }
    }

    // Extract declared character interactions from the scene metadata.
    // Use sceneHint (original scene description with metadata block) rather than
    // originalPrompt (image prompt where metadata was already stripped).
    let interactionsBlock = '(none declared)';
    let sceneIntentBlock = '(none declared)';
    try {
      const interactionSource = sceneHint || originalPrompt;
      const sceneMeta = getStoryHelpers().extractSceneMetadata(interactionSource);
      const interactions = sceneMeta?.interactions
        || (Array.isArray(sceneMeta?.fullData?.interactions) ? sceneMeta.fullData.interactions : null);
      if (interactions && interactions.length > 0) {
        interactionsBlock = interactions
          .map(i => `- ${i.character || '?'} + ${i.object || '?'}: ${i.where || '(no placement given)'}`)
          .join('\n');
      }
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
            parts.push({ text: `Reference: ${charName}` });
          }
          parts.push({
            inline_data: {
              mime_type: 'image/jpeg',
              data: compressedBase64
            }
          });
          addedCount++;
        } catch (refErr) {
          skippedCount++;
          log.warn(`⚠️ [EVAL] Reference photo${charName ? ` "${charName}"` : ''} failed to load (${refErr.message}) — skipping`);
        }
      }
      log.verbose(`📊 [EVAL] Added ${addedCount} reference images (${cacheHits} cached, ${addedCount - cacheHits} compressed)`);
      if (skippedCount > 0) {
        log.warn(`⚠️ [EVAL] ${skippedCount}/${referenceImages.length} reference photos unusable — figure-identity matching will be degraded${addedCount === 0 ? ' (NO references: matches[] will be empty)' : ''}`);
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
          const sid = evalOptions?.storyMeta?.storyId;
          if (sid) require('./runMetrics').forJob(sid).count('eval_refs_attach_failed');
        } catch { /* metrics are best-effort */ }
        return null;
      }
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
      // Route to Grok vision API for xAI models
      const modelConfig = TEXT_MODELS[model];
      if (modelConfig?.provider === 'xai') {
        return require('./images').callGrokVisionAPI(model, modelConfig.modelId || model, parts, evaluationPrompt);
      }
      return withRetry(async () => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              maxOutputTokens: 32000,
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
          const grokFallbackId = 'grok-4-fast';
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
      let fixableIssues = [];
      if (parsedJson.fixable_issues && Array.isArray(parsedJson.fixable_issues)) {
        fixableIssues = parsedJson.fixable_issues
          .filter(i => i.description)
          .map(i => ({
            description: i.description,
            severity: i.severity || 'MODERATE',
            type: i.type || 'default',
            character: i.character || null,  // Preserved for bbox matching (incl. STEP 2C proportion issues)
            fix: i.fix || `Fix: ${i.description}`
          }));
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
              agreement: m.agreement,
            }));
          }
        }
      } catch (juryErr) {
        log.warn(`[EVAL] multi-judge merge skipped (${juryErr.message}) — using primary judge only`);
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
          if (rows.length && typeof db.recordEvalFindings === 'function') db.recordEvalFindings(rows).catch(() => {});
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
      if (matches.length > 0) {
        log.info(`📊 [EVAL] Character matches: ${matches.map(m => `Figure ${m.figure} → ${m.reference} (${Math.round(m.confidence * 100)}%)`).join(', ')}`);
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
          const sid = evalOptions?.storyMeta?.storyId;
          if (sid) require('./runMetrics').forJob(sid).count('eval_matches_missing');
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
          if (semanticResult && semanticResult.semanticIssues && semanticResult.semanticIssues.length > 0) {
            // Apply semantic penalties to score
            // CRITICAL (-30), MAJOR (-20) severity
            let semanticPenalty = 0;
            for (const issue of semanticResult.semanticIssues) {
              if (issue.severity === 'CRITICAL') semanticPenalty += 30;
              else if (issue.severity === 'MAJOR') semanticPenalty += 20;
              else semanticPenalty += 10;
            }
            finalScore = score - semanticPenalty;  // no 0-floor: see scoring.js computeMathFinalScore
            log.info(`🔍 [SEMANTIC] Semantic score: ${semanticResult.score}/100, penalty: ${semanticPenalty} points (quality ${score} → final ${finalScore})`);
            // Append semantic issues to summary
            const semanticSummary = semanticResult.semanticIssues.map(i => i.problem).join('; ');
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
          if (threeStageResult?.fixableIssues?.length) {
            fixableIssues = [...fixableIssues, ...threeStageResult.fixableIssues];
            // Recompute visual score from merged fixable_issues (same rubric
            // as main eval). Then re-apply semantic penalty on top.
            const mergedPenalty = fixableIssues.reduce(
              (sum, i) => sum + (SEVERITY_PENALTY[String(i.severity).toUpperCase()] ?? 1),
              0
            );
            const mergedRawScore = Math.max(0, Math.min(10, 10 - mergedPenalty));
            visualScore = mergedRawScore * 10;
            // Re-derive semantic penalty so finalScore = visualScore − semantic.
            // (Was applied to `score` above; recomputed here against visualScore.)
            let semanticPenalty = 0;
            if (semanticResult?.semanticIssues?.length) {
              for (const issue of semanticResult.semanticIssues) {
                if (issue.severity === 'CRITICAL') semanticPenalty += 30;
                else if (issue.severity === 'MAJOR') semanticPenalty += 20;
                else semanticPenalty += 10;
              }
            }
            finalScore = visualScore - semanticPenalty;  // no 0-floor: see scoring.js computeMathFinalScore
            log.info(`📊 [THREE-STAGE] ${pageContext ? `[${pageContext}] ` : ''}Merged ${threeStageResult.fixableIssues.length} issue(s); recomputed visual ${score}→${visualScore}, final ${finalScore} (semantic −${semanticPenalty})`);
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
        fixableIssues: Array.isArray(fixableIssues) ? fixableIssues : [],  // always an array — eliminates downstream null-checks
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
            // Apply semantic penalties to score
            let semanticPenalty = 0;
            for (const issue of semanticResult.semanticIssues) {
              if (issue.severity === 'CRITICAL') semanticPenalty += 30;
              else if (issue.severity === 'MAJOR') semanticPenalty += 20;
              else semanticPenalty += 10;
            }
            finalScore = qualityScore - semanticPenalty;  // no 0-floor: see scoring.js computeMathFinalScore
            log.info(`🔍 [SEMANTIC] Applied ${semanticPenalty} point penalty for semantic issues (${qualityScore} → ${finalScore})`);
            issuesSummary = `SEMANTIC: ${semanticResult.semanticIssues.map(i => i.problem).join('; ')}`;
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
          if (threeStageResult && threeStageResult.score < finalScore) {
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
  runVisualInventory,
  validateEmptyScene,
  capComplianceIdentitySeverity,
  evaluateThreeStage,
  sanitizeForGemini,
  evaluateImageQuality,
  IMAGE_QUALITY_THRESHOLD,
};
