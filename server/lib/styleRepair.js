/**
 * Dedicated STYLE-consistency repair path (roadmap Pt 10).
 *
 * The problem this solves: `checkStoryStyleConsistency` (styleConsistency.js)
 * is DETECTION-ONLY — it clusters pages by style and flags outliers, but
 * nothing repaints them, so a page that flips art style is flagged then
 * shipped anyway. This module is the missing repair half: it takes a
 * style-outlier page and repaints it TOWARD the story's dominant style
 * cluster, preserving all content/composition/characters (style transfer,
 * not re-illustration).
 *
 * It is deliberately a SEPARATE path from character/entity repair, and is
 * MODEL-PARAMETERIZED so the Test Lab can A/B Gemini vs Grok as the
 * style-repair model (owner decision 2026-07-25). It REUSES production code:
 *   - detection: `checkStoryStyleConsistency` (styleConsistency.js) — reused,
 *     never re-detected here.
 *   - the repaint: `editImageWithPrompt` (images.js) — the shared production
 *     edit dispatcher that routes to `editWithGrok` (grok backend) or the
 *     Gemini generateContent edit path (gemini backend) based on the model id,
 *     and already handles Grok's input-aspect coercion quirk (measures the
 *     source aspect, snaps to the nearest preset). We do NOT hand-roll a
 *     provider call.
 *   - the gate: `checkStyleMatch` (images.js) — the same binary same-style
 *     classifier the Test Lab already uses as a hard gate, applied here to the
 *     path's OWN output so a repaint that did not actually land in the target
 *     style class is flagged/rejected.
 *
 * PRODUCTION WIRING: deferred — see docs/decisions.md Pt 10. This is
 * Test-Lab-first; nothing in the production auto-repair pipeline calls it yet.
 */

const { log } = require('../utils/logger');

/**
 * opts.model → the production IMAGE_MODELS id whose backend is that provider.
 * `editImageWithPrompt` resolves the backend from IMAGE_MODELS[model].backend,
 * so choosing the model id here IS the per-provider dispatch — 'grok-imagine'
 * dispatches to editWithGrok, 'gemini-2.5-flash-image' to the Gemini edit path.
 * These two ids are the canonical page-image models for each backend
 * (server/config/models.js).
 */
const STYLE_REPAIR_MODEL_IDS = {
  gemini: 'gemini-2.5-flash-image',
  grok: 'grok-imagine',
};

/**
 * Generic style-repaint instruction. MUST stay story-agnostic (repo rule) —
 * no names, characters, settings or plot. It is passed as the EDIT_INSTRUCTION
 * of `editImageWithPrompt`'s `illustrationEdit` template (the same wrapping
 * every live inpaint uses), so it needs only to describe the transform.
 */
const STYLE_REPAIR_INSTRUCTION =
  'Repaint this illustration so its artistic style exactly matches the style reference image: ' +
  'the same medium, brushwork, line quality, colour palette, shading and texture. ' +
  'This is a STYLE transfer ONLY — keep the existing composition, characters, poses, ' +
  'facial identity, layout and every content element unchanged. Change nothing except the ' +
  'rendering technique, so this page belongs to the same visual style as the rest of the book.';

/**
 * Resolve the opts.model selector to a production model id.
 * @param {'gemini'|'grok'} model
 * @returns {string} IMAGE_MODELS id
 */
function resolveStyleRepairModelId(model) {
  const id = STYLE_REPAIR_MODEL_IDS[model];
  if (!id) {
    throw new Error(`repairPageStyle: opts.model must be 'gemini' or 'grok', got ${JSON.stringify(model)}`);
  }
  return id;
}

/**
 * Deterministic planner (unit-testable, no API calls): given a
 * `checkStoryStyleConsistency`-shaped detection result + the story data,
 * decide which pages to repair and what the target-style reference is.
 *
 * - Repair targets = detected outliers that are real story pages (page ≥ 1)
 *   with a stored image. Front-cover outliers (page -1) are SKIPPED: a cover
 *   carries burned-in title typography, so repainting it is out of scope for
 *   this style path (see docs/decisions.md Pt 10).
 * - Target reference = the anchor page's image (the cleanest representative of
 *   the dominant cluster). Falls back to the first dominant-cluster page with
 *   an image if the reported anchor has none.
 *
 * @param {Object} detection - { dominantCluster[], anchorPage, outliers[] }
 * @param {Object} storyData - { sceneImages: [{pageNumber, imageData}] }
 * @returns {{ anchorPage: number|null, dominantCluster: number[],
 *   targets: Array<{page,image,targetRefPage,targetRefImage,severity,differences}>,
 *   skipped: Array<{page,reason}> }}
 */
function planStyleRepair(detection, storyData) {
  const det = detection || {};
  const pagesByNum = new Map();
  for (const s of (storyData?.sceneImages || [])) {
    if (s && s.imageData && typeof s.pageNumber === 'number') {
      pagesByNum.set(s.pageNumber, s.imageData);
    }
  }

  const dominantCluster = Array.isArray(det.dominantCluster) ? det.dominantCluster : [];

  // Pick the anchor reference image: the reported anchorPage first, then any
  // dominant-cluster page — but only a real story page (≥1) that has an image.
  let anchorPage = null;
  let anchorImage = null;
  const anchorCandidates = [];
  if (typeof det.anchorPage === 'number') anchorCandidates.push(det.anchorPage);
  for (const p of dominantCluster) anchorCandidates.push(p);
  for (const p of anchorCandidates) {
    if (p >= 1 && pagesByNum.has(p)) { anchorPage = p; anchorImage = pagesByNum.get(p); break; }
  }

  const targets = [];
  const skipped = [];
  const seen = new Set();
  for (const o of (det.outliers || [])) {
    // Tolerate both shapes: {page, severity, differences} (current) or a bare
    // page number (defensive — the roadmap described outliers as page indices).
    const page = (o && typeof o === 'object') ? o.page : o;
    if (typeof page !== 'number') { skipped.push({ page: page ?? null, reason: 'outlier has no page number' }); continue; }
    if (seen.has(page)) continue;
    seen.add(page);
    if (page < 1) { skipped.push({ page, reason: 'front-cover / non-page outlier — cover style repaint out of scope' }); continue; }
    if (!pagesByNum.has(page)) { skipped.push({ page, reason: 'no stored image for page' }); continue; }
    if (!anchorImage) { skipped.push({ page, reason: 'no dominant-cluster reference image available' }); continue; }
    targets.push({
      page,
      image: pagesByNum.get(page),
      targetRefPage: anchorPage,
      targetRefImage: anchorImage,
      severity: (o && typeof o === 'object' && o.severity) || null,
      differences: (o && typeof o === 'object' && Array.isArray(o.differences)) ? o.differences : [],
    });
  }

  return { anchorPage, dominantCluster, targets, skipped };
}

/**
 * Repaint ONE outlier page toward the target (dominant) style.
 *
 * @param {string} pageImage - data-URI of the outlier page (source to repaint)
 * @param {string|null} targetStyleRef - data-URI of a dominant-cluster page
 *   (the style signal, attached as a reference image); may be null (then the
 *   repaint relies on the `artStyle` descriptor alone and the gate is skipped).
 * @param {Object} [opts]
 * @param {'gemini'|'grok'} [opts.model='grok'] - which provider to A/B.
 * @param {string|null} [opts.artStyle=null] - the story's art-style id/descriptor,
 *   resolved inside editImageWithPrompt via resolveArtStyle (extra anchor).
 * @param {string|null} [opts.aspectRatio=null] - aspect override; normally left
 *   null so editImageWithPrompt measures the source's own aspect.
 * @param {Function} [opts.editFn] - injectable editImageWithPrompt (tests).
 * @param {Function} [opts.styleMatchFn] - injectable checkStyleMatch (tests).
 * @returns {Promise<{imageData, model, modelId, beforeStyleMatch, afterStyleMatch, passedGate, usage}>}
 */
async function repairPageStyle(pageImage, targetStyleRef, opts = {}) {
  const {
    model = 'grok',
    artStyle = null,
    aspectRatio = null,
    editFn = null,
    styleMatchFn = null,
  } = opts;

  if (!pageImage) throw new Error('repairPageStyle: pageImage is required');
  const modelId = resolveStyleRepairModelId(model);

  // Default to the production functions; injection keeps the unit tests
  // free of live image/vision API calls.
  const editImage = editFn || require('./images').editImageWithPrompt;
  const checkStyle = styleMatchFn || require('./images').checkStyleMatch;

  // BEFORE: how far the outlier is from the target style (baseline for the A/B).
  let beforeStyleMatch = null;
  if (targetStyleRef) {
    try {
      beforeStyleMatch = await checkStyle(targetStyleRef, pageImage);
    } catch (err) {
      log.warn(`🎨 [STYLE-REPAIR] before-match unavailable (${err.message}) — continuing`);
    }
  }

  // REPAINT via the shared production edit dispatcher. The target-style page is
  // attached as a reference image so the model can see the dominant look; the
  // model id selects the backend (grok → editWithGrok, gemini → Gemini edit).
  const refs = targetStyleRef ? [targetStyleRef] : [];
  log.info(`🎨 [STYLE-REPAIR] repainting page toward dominant style via ${model} (${modelId}), refs=${refs.length}`);
  const result = await editImage(pageImage, STYLE_REPAIR_INSTRUCTION, modelId, refs, artStyle, aspectRatio);
  if (!result || !result.imageData) {
    throw new Error(`repairPageStyle: ${model} (${modelId}) edit produced no image`);
  }

  // GATE on the path's OWN output: did the repaint actually land in the target
  // style CLASS? Mirrors the Test Lab char-repair style gate. Gate
  // unavailability (no Gemini key / transient error) is logged, not fatal —
  // it must not turn a real repaint into a hard failure.
  let afterStyleMatch = null;
  let passedGate = null;
  if (targetStyleRef) {
    try {
      afterStyleMatch = await checkStyle(targetStyleRef, result.imageData);
      passedGate = afterStyleMatch.sameStyle === true;
      if (passedGate === false) {
        log.warn(`🎨 [STYLE-REPAIR] gate FAIL: ${model} output is "${afterStyleMatch.styleB}" but target is "${afterStyleMatch.styleA}" — repaint rejected as off-style`);
      } else {
        log.info(`🎨 [STYLE-REPAIR] gate PASS: ${model} output matches target style class`);
      }
    } catch (err) {
      log.warn(`🎨 [STYLE-REPAIR] style gate unavailable (${err.message}) — repaint returned ungated`);
    }
  }

  return {
    imageData: result.imageData,
    model,
    modelId,
    beforeStyleMatch,
    afterStyleMatch,
    passedGate,
    usage: result.usage || null,
  };
}

module.exports = {
  repairPageStyle,
  planStyleRepair,
  resolveStyleRepairModelId,
  STYLE_REPAIR_MODEL_IDS,
  STYLE_REPAIR_INSTRUCTION,
};
