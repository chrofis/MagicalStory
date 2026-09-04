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
 * PRODUCTION WIRING: live since 2026-07-31 (owner directive) — the Step-5
 * style audit in runUnifiedRepairPipeline (images.js) calls
 * planStyleRepair → repairPageStyle for pages AND covers, gated by
 * MODEL_DEFAULTS.styleRepairProduction (env STYLE_REPAIR_PRODUCTION,
 * default true) with model per MODEL_DEFAULTS.styleRepairModel. The Test
 * Lab `style_repair` stage remains the Gemini-vs-Grok A/B harness.
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
 * Generic style-repaint prompt. MUST stay story-agnostic (repo rule) — no
 * names, characters, settings or plot. Validated 2026-08-09 on real pages
 * (p3 / p10 / the initial page): character-focused and feature-PRESERVING —
 * keeps eyewear if a character has it and never invents it, keeps eyes exactly
 * as shown. It is sent RAW to the Gemini image edit (see geminiStyleRepaint),
 * NOT through editImageWithPrompt's `illustration-edit` template — that
 * template's "keep faces unchanged / maintain the same palette" lines fight a
 * style repaint. The earlier "minimal detail / only suggest features" wording
 * DROPPED small features (a child's eyes) and let the model reinvent the eye
 * area as glasses — removed. `${artStyleDesc}` = the resolved medium.
 */
function buildStyleRepairPrompt(artStyleDesc) {
  return `The background of this illustration is already in the correct art style, but the CHARACTERS are rendered too realistically and photographically — the people are the main thing to fix. Repaint the people into this art style so they match the rest of the illustration: ${artStyleDesc}
Change ONLY the art style. Every other detail of each person stays exactly as in the source: identical facial features, eyes exactly as shown, identical expression, identical eyewear or lack of eyewear, identical hair and clothing. Add nothing and remove nothing — no invented glasses, no closed or missing eyes. Keep the background, composition and framing unchanged; add no white paper border.`;
}

/**
 * Direct Gemini image-edit for style repair — ships EXACTLY the validated call
 * (raw prompt, temp 0.7, the page's own aspect), bypassing editImageWithPrompt's
 * illustration-edit template. Retries on Gemini's intermittent safety no-image
 * (IMAGE_OTHER / IMAGE_SAFETY, observed 1-in-3 on some pages); throws when
 * exhausted so the caller keeps the original page as the fallback.
 */
async function geminiStyleRepaint(prompt, pageImage, { retries = 3, refImages = [] } = {}) {
  const r2 = require('./r2');
  const sharp = require('sharp');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing for style repair');
  // Output at the page's own aspect, snapped to the nearest preset Gemini takes.
  let aspectRatio = '1:1';
  try {
    const buf = Buffer.from(r2.stripDataUriPrefix(pageImage), 'base64');
    const { width, height } = await sharp(buf).metadata();
    if (width && height) {
      const presets = [['9:16', 9 / 16], ['2:3', 2 / 3], ['3:4', 3 / 4], ['1:1', 1], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9]];
      const rr = width / height;
      aspectRatio = presets.reduce((b, p) => Math.abs(Math.log(rr / p[1])) < Math.abs(Math.log(rr / b[1])) ? p : b)[0];
    }
  } catch { /* keep default 1:1 */ }
  const mime = String(pageImage).match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
  const parts = [{ text: prompt }, { inlineData: { mimeType: mime, data: r2.stripDataUriPrefix(pageImage) } }];
  // STYLE REFERENCE SHEETS (owner, 2026-08-24). The repaint was prompt-only
  // because a content-rich reference — a sibling PAGE — made the model copy
  // that page's people (verified 2026-08-09). A character reference sheet is
  // not that: it shows THESE characters already painted in the commissioned
  // style, so there is no foreign cast to leak in, and it answers the question
  // the words alone were not moving the model on ("what does this person look
  // like painted?"). Labelled so the model reads them as style samples, never
  // as scene content to add.
  if (refImages.length > 0) {
    parts.push({ text: `The following ${refImages.length === 1 ? 'image is a style reference sheet' : `${refImages.length} images are style reference sheets`} showing these same characters already painted in the target style. Copy the PAINTING TECHNIQUE from them — brushwork, skin, hair and fabric handling. Do not copy their poses, framing or background, and add no figure from them into the illustration.` });
    for (const ref of refImages) {
      const rmime = String(ref).match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
      parts.push({ inlineData: { mimeType: rmime, data: r2.stripDataUriPrefix(ref) } });
    }
  }
  const body = { contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], temperature: 0.7, imageConfig: { aspectRatio } } };
  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= retries; attempt++) {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    if (!resp.ok) { lastReason = `HTTP ${resp.status}`; log.warn(`🎨 [STYLE-REPAIR] gemini ${lastReason} (attempt ${attempt}/${retries})`); continue; }
    const j = await resp.json();
    const cand = j?.candidates?.[0];
    const part = (cand?.content?.parts || []).find(p => p.inlineData || p.inline_data);
    const inline = part?.inlineData || part?.inline_data;
    if (inline) {
      const um = j?.usageMetadata;
      // direct_cost mirrors cost: addUsage (storyJobPipeline) only sums
      // usage.direct_cost, so per-image spend recorded in `cost` alone lands as $0.
      const usage = { input_tokens: um?.promptTokenCount || 0, output_tokens: um?.candidatesTokenCount || 0, cost: 0.039, direct_cost: 0.039 };
      return { imageData: 'data:image/jpeg;base64,' + inline.data, usage };
    }
    lastReason = cand?.finishReason || 'no-image';
    log.warn(`🎨 [STYLE-REPAIR] gemini returned no image (${lastReason}, attempt ${attempt}/${retries})`);
  }
  throw new Error(`gemini style repaint produced no image after ${retries} attempts (${lastReason})`);
}

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
 * - Repair targets = detected outliers with a stored image — story pages
 *   (page ≥ 1) AND covers (negative page convention: frontCover -1,
 *   initialPage -2, backCover -3, read from storyData.coverImages). Covers
 *   are treated the same as normal pages (owner directive 2026-07-31,
 *   supersedes the earlier front-cover skip: covers are TEXTLESS under
 *   appSideCoverType — typography is composited after the art — so a style
 *   repaint never touches title lettering).
 * - Target reference = the anchor page's image (the cleanest representative of
 *   the dominant cluster). Falls back to the first dominant-cluster page with
 *   an image if the reported anchor has none. The anchor is always a real
 *   story page (≥ 1) — covers are repainted TOWARD the pages' dominant style,
 *   never used as the style reference.
 *
 * @param {Object} detection - { dominantCluster[], anchorPage, outliers[] }
 * @param {Object} storyData - { sceneImages: [{pageNumber, imageData}],
 *   coverImages?: { frontCover|initialPage|backCover: { imageData } } }
 * @returns {{ anchorPage: number|null, dominantCluster: number[],
 *   targets: Array<{page,image,targetRefPage,targetRefImage,severity,differences}>,
 *   skipped: Array<{page,reason}> }}
 */
const { COVER_PAGE_NUMBERS } = require('./coverKeys');

function planStyleRepair(detection, storyData, opts = {}) {
  const det = detection || {};
  // COMMISSIONED-STYLE MODE (owner, 2026-08-20). When the dominant cluster is
  // itself the wrong medium there IS no good page to aim at, and the pipeline
  // used to skip repair entirely — leaving a whole off-medium book with no
  // recourse (staging job_1787252581387_6sn8z0nh2 shipped a photographic back
  // cover this way). Passing `refImage` overrides the anchor search: the caller
  // supplies the style's own anchor asset, so every outlier is judged against
  // what was COMMISSIONED instead of against a drifted sibling page. The
  // repaint itself is unaffected — it has always been prompt-only (see
  // repairPageStyle), so this changes what the GATE compares, not what is sent
  // to the generator.
  const { refImage = null, refLabel = null } = opts;
  const pagesByNum = new Map();
  for (const s of (storyData?.sceneImages || [])) {
    if (s && s.imageData && typeof s.pageNumber === 'number') {
      pagesByNum.set(s.pageNumber, s.imageData);
    }
  }
  // Covers join the repairable set at their negative page numbers — as their
  // TEXTLESS art wherever it exists (2026-08-24). Feeding the composed cover to
  // an image model hands it the title as pixels to restyle: Lab #837 selected
  // page -1 and all three arms repainted the lettering along with the art. It
  // stayed legible that once; nothing guarantees it. `${coverKey}Art` is the
  // canonical textless source, and the caller restamps with composeCover the
  // same way the cover-inpaint path does. No art stored (older stories) → fall
  // back to the composed cover, which is still better than skipping the outlier.
  const coverArtSource = new Map();
  for (const [coverKey, coverPage] of Object.entries(COVER_PAGE_NUMBERS)) {
    const art = storyData?.coverImages?.[`${coverKey}Art`]?.imageData;
    const composed = storyData?.coverImages?.[coverKey]?.imageData;
    const img = art || composed;
    if (img) {
      pagesByNum.set(coverPage, img);
      coverArtSource.set(coverPage, { coverKey, usedArt: !!art });
    }
  }

  const dominantCluster = Array.isArray(det.dominantCluster) ? det.dominantCluster : [];

  // Pick the anchor reference image: the reported anchorPage first, then any
  // dominant-cluster page — but only a real story page (≥1) that has an image.
  let anchorPage = null;
  let anchorImage = null;
  if (refImage) {
    // Commissioned-style mode: the supplied reference IS the target. No page is
    // the anchor, so anchorPage stays null and `refLabel` names it in the plan.
    anchorImage = refImage;
  } else {
    const anchorCandidates = [];
    if (typeof det.anchorPage === 'number') anchorCandidates.push(det.anchorPage);
    for (const p of dominantCluster) anchorCandidates.push(p);
    for (const p of anchorCandidates) {
      if (p >= 1 && pagesByNum.has(p)) { anchorPage = p; anchorImage = pagesByNum.get(p); break; }
    }
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
    if (!pagesByNum.has(page)) { skipped.push({ page, reason: page < 0 ? 'no stored image for cover' : 'no stored image for page' }); continue; }
    if (!anchorImage) { skipped.push({ page, reason: 'no dominant-cluster reference image available' }); continue; }
    const coverSrc = coverArtSource.get(page) || null;
    targets.push({
      // Covers only: which cover this is, and whether the repaint source is the
      // textless art. The caller restamps the title back on when it is.
      coverKey: coverSrc?.coverKey || null,
      usedArt: coverSrc ? coverSrc.usedArt : false,
      page,
      image: pagesByNum.get(page),
      targetRefPage: anchorPage,
      targetRefLabel: refLabel,
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
    model = 'gemini',
    artStyle = null,
    aspectRatio = null,
    editFn = null,
    repaintFn = null,
    styleMatchFn = null,
    compareFn = null,
    refImages = [],
  } = opts;

  if (!pageImage) throw new Error('repairPageStyle: pageImage is required');
  const modelId = resolveStyleRepairModelId(model);

  // Default to the production functions; injection keeps the unit tests
  // free of live image/vision API calls.
  const editImage = editFn || require('./images').editImageWithPrompt;
  const checkStyle = styleMatchFn || require('./styleAnalysis').checkStyleMatch;
  const compareStyle = compareFn || require('./styleAnalysis').compareStyleProximity;

  // BEFORE: how far the outlier is from the target style (baseline for the A/B).
  let beforeStyleMatch = null;
  if (targetStyleRef) {
    try {
      beforeStyleMatch = await checkStyle(targetStyleRef, pageImage);
    } catch (err) {
      log.warn(`🎨 [STYLE-REPAIR] before-match unavailable (${err.message}) — continuing`);
    }
  }

  // REPAINT — PROMPT-ONLY, no style-reference image (a content-rich reference
  // makes the model copy the reference's people/scene — verified 2026-08-09).
  // The style signal is the resolved art-style descriptor baked into the prompt.
  // Gemini is the validated engine (it restyles faces where Grok no-ops); Grok
  // is kept only as the Test Lab A/B alternate.
  const { resolveArtStyle } = require('./storyHelpers');
  const styleDesc = (artStyle && resolveArtStyle(artStyle, model)) || 'the art style of the rest of the illustration';
  // opts.promptOverride lets the Test Lab A/B the WORDING without a deploy.
  // Production always uses buildStyleRepairPrompt; nothing else passes this.
  const prompt = opts.promptOverride || buildStyleRepairPrompt(styleDesc);
  log.info(`🎨 [STYLE-REPAIR] repainting page toward dominant style via ${model} (${modelId})`);
  let imageData;
  let usage = null;
  if (model === 'grok') {
    const r = await editImage(pageImage, prompt, modelId, refImages, artStyle, aspectRatio);
    if (!r || !r.imageData) throw new Error(`repairPageStyle: grok (${modelId}) produced no image`);
    imageData = r.imageData; usage = r.usage || null;
  } else {
    // repaintFn: injectable Gemini repaint so the unit test can exercise this
    // branch without a live image API (the grok branch has editFn for that).
    ({ imageData, usage } = await (repaintFn || geminiStyleRepaint)(prompt, pageImage, { refImages }));
  }
  const result = { imageData, usage };

  // GATE — COMPARATIVE, not absolute (owner, 2026-08-24). The question is
  // "is the repaint better than the page we already have", never "is the
  // repaint perfect": the old absolute check (`checkStyleMatch(anchor, after)
  // .sameStyle === true`) discarded every partial fix and shipped the
  // untouched original instead, which on a photographic page means shipping
  // the photograph. Measured on prod job_1787514321173_gvs2ojo4o0n: 11
  // repaints, 6 rejected, among them the only fully photographic page in the
  // book. One call judges both images side by side.
  //
  // Ties and `before` keep the original — a repaint has to WIN to replace a
  // page, so a no-op repaint (Gemini occasionally returns the input barely
  // touched) cannot displace anything.
  let afterStyleMatch = null;
  let styleComparison = null;
  let passedGate = null;
  try {
    styleComparison = await compareStyle(pageImage, result.imageData, {
      anchorImage: targetStyleRef || null,
      artStyleDesc: styleDesc,
    });
    const changed = styleComparison.changed || [];
    // BOTH conditions. A repaint that improves the style while rewriting the
    // costume is a regression, not a fix: staging job_1787514666616_yw9qsv1vf
    // p1 turned a green tricorn into a red headscarf. Clothing is contracted
    // per story (clothingRequirements) — a style pass may not renegotiate it.
    passedGate = styleComparison.better === 'after' && changed.length === 0;
    if (passedGate) {
      log.info(`🎨 [STYLE-REPAIR] gate PASS: repaint is closer to the target style and changed nothing else — ${styleComparison.reason}`);
    } else if (changed.length > 0) {
      log.warn(`🎨 [STYLE-REPAIR] gate FAIL: repaint altered content, not just style — ${changed.join('; ')}`);
    } else {
      log.warn(`🎨 [STYLE-REPAIR] gate FAIL: repaint is not closer to the target style (${styleComparison.better}) — ${styleComparison.reason}`);
    }
  } catch (err) {
    // Gate unavailability (no Gemini key / transient error) is logged, not
    // fatal — it must not turn a real repaint into a hard failure.
    log.warn(`🎨 [STYLE-REPAIR] style gate unavailable (${err.message}) — repaint returned ungated`);
  }

  return {
    imageData: result.imageData,
    model,
    modelId,
    beforeStyleMatch,
    afterStyleMatch,
    styleComparison,
    passedGate,
    usage: result.usage || null,
  };
}

module.exports = {
  repairPageStyle,
  planStyleRepair,
  resolveStyleRepairModelId,
  STYLE_REPAIR_MODEL_IDS,
  buildStyleRepairPrompt,
  geminiStyleRepaint,
};
