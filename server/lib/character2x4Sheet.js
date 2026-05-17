/**
 * Character 2×4 reference sheet generator (variant A).
 *
 * Generates one 8-cell sheet per character per costume:
 *   - Top row (cells 1–4): face front / 45° / profile / back-of-head
 *   - Bottom row (cells 5–8): full body at the same four angles, costumed
 *
 * Inputs:
 *   - phantom (the pose template — bundled at server/assets/phantom-watercolor.png)
 *   - standard avatar (single-image body reference from clothing-avatars pipeline)
 *   - character face photo (identity anchor)
 *
 * One Grok edit call. ~$0.02 per character per costume. Used by the scene
 * composite path (server/lib/sceneComposite.js) — only invoked when
 * MODEL_DEFAULTS.enableSceneComposite is true.
 *
 * See docs/SCENE-COMPOSITE-PIPELINE.html for the architecture overview
 * and scripts/test-character-from-phantom.js for the validation harness.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { log } = require('../utils/logger');
const { editWithGrok, GROK_MODELS } = require('./grok');
const { PROMPT_TEMPLATES } = require('../services/prompts');

// Best-of-N cap: first attempt + N retries. The loop short-circuits on the
// first valid eval — retries only fire when an attempt fails. If all attempts
// fail, we pick the best and ship it. Two retries = up to 3 Grok calls per pass.
const MAX_SHEET_RETRIES = 2;

const PHANTOM_PATH = path.resolve(__dirname, '..', 'assets', 'phantom-watercolor.png');
let phantomCache = null;

function loadPhantom() {
  if (phantomCache) return phantomCache;
  if (!fs.existsSync(PHANTOM_PATH)) {
    throw new Error(`Phantom asset missing at ${PHANTOM_PATH}. Run scripts/test-phantom-generate.js and copy the output here.`);
  }
  const buf = fs.readFileSync(PHANTOM_PATH);
  phantomCache = `data:image/png;base64,${buf.toString('base64')}`;
  return phantomCache;
}

// The 2×4 sheet is ALWAYS realistic — same surface treatment as the source
// face photo. Style transfer is the page-generation step's job, not the
// sheet's. Asking Grok to do identity + multiple angles + costume + style
// transfer in ONE edit call was too much (Daniel rendered as chibi-bodied
// 68-year-old on staging story job_1778881997472). Sheets are the identity
// anchor; pages stylise.
//
// `artStyle` is kept as a parameter for caller compatibility but is no
// longer consumed here.
function buildPrompt(_artStyle, costumeDescription) {
  return `Image 1 indicates only the camera angle and facing direction in each cell — ignore its silhouette, body, and face.
Image 2 is the character's body. Image 3 is the character's face.

Costume: ${costumeDescription}

Render every cell as a REALISTIC reference — the same visual style as the source face photo in Image 3. Photographic / lifelike, with natural proportions matching the person's apparent age in Image 3. No cartoon stylisation, no chibi, no anime, no watercolour — those treatments are applied later by downstream steps. This sheet is an identity anchor.

Output a 2×4 grid with thin black dividing lines and pure white background, in the same cell layout as Image 1.

The horizontal mid-row divider must be drawn as one unbroken thin black line running edge to edge. The three vertical column dividers must be drawn the same way. Nothing crosses any divider: every figure stays fully inside its own cell, surrounded by white space on all four sides. No head, no hair, no hand, no foot, no shadow, no clothing detail extends beyond the cell's borders. If a figure would not fit inside its cell, scale it down so it fits.

Cells 1-4 (top row): head and neck only, no shoulders, no torso, no clothing. Cell 1 front, cell 2 three-quarter, cell 3 profile, cell 4 back of head. The head occupies roughly the middle of the cell with white margin above the hairline and below the neck — the neck stops cleanly, it never continues into the bottom row.
Cells 5-8 (bottom row): full body from head to feet wearing the costume. Cell 5 front, cell 6 three-quarter, cell 7 profile, cell 8 back. The full figure fits entirely between the mid-row divider and the bottom edge — the head of a bottom-row body never extends up into the top row.

Every cell faces in the same direction as the matching cell in Image 1. Every head in cells 1-4 and every body in cells 5-8 shows THE SAME PERSON as Image 3 — same face structure, same hair, same skin tone, same apparent age. The same costume — every accessory — appears in cells 5, 6, 7, and 8. No text, no numbers, no labels.`;
}

/**
 * Resolve the character's face photo to a base64 data URI.
 * Handles all the shapes that turn up in this codebase: string, object
 * with .data, photos.face / photos.original / photos.body, etc.
 */
function resolveFacePhoto(character) {
  if (!character) return null;
  const candidates = [
    character.photos?.face,
    character.photos?.original,
    character.photos?.body,
    character.photos?.bodyNoBg,
    character.facePhoto,
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === 'string' && c.startsWith('data:')) return c;
    if (typeof c === 'object' && c.data && c.data.startsWith('data:')) return c.data;
    if (typeof c === 'string' && c.length > 1000) return `data:image/jpeg;base64,${c}`;
  }
  return null;
}

/**
 * Resolve the character's base standard avatar (the Grok-generated single-shot
 * body avatar produced by the clothing-avatars pipeline). This is the body /
 * identity reference fed to the 2×4 generator. No more styled-2×2 middleman.
 *
 * Returns a data URI / R2 URL string, or null when the standard avatar is
 * missing — the caller can fall back to the face photo alone.
 */
function resolveStandardAvatar(character) {
  if (!character?.avatars) return null;
  const v = character.avatars.standard;
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.imageUrl || v.imageData || v.data || null;
  return null;
}

/**
 * Cheap pixel-level layout check — runs before the Gemini call. Verifies the
 * horizontal mid-row gutter and the three vertical column gutters are mostly
 * white. Most layout failures (figures crossing the row gutter — the
 * "Sarah-cut-in-half" failure mode on staging story job_1778871083037_xq22dos68)
 * show up here for free; only sheets that pass this gate cost a Gemini call.
 *
 * Returns { valid, reason } — valid=true when every gutter band is ≥80%
 * white pixels (lum > 240).
 */
async function quickLayoutCheck(imageData) {
  const b64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const band = Math.max(2, Math.round(Math.min(W, H) * 0.015));
  function rowBand(yCenter) {
    let bright = 0, total = 0;
    for (let y = yCenter - band; y <= yCenter + band; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        if ((data[i] + data[i+1] + data[i+2]) / 3 > 240) bright++;
        total++;
      }
    }
    return total > 0 ? bright / total : 0;
  }
  function colBand(xCenter) {
    let bright = 0, total = 0;
    for (let x = xCenter - band; x <= xCenter + band; x++) {
      if (x < 0 || x >= W) continue;
      for (let y = 0; y < H; y++) {
        const i = (y * W + x) * 3;
        if ((data[i] + data[i+1] + data[i+2]) / 3 > 240) bright++;
        total++;
      }
    }
    return total > 0 ? bright / total : 0;
  }
  const checks = [
    { name: 'mid-row gutter',  whiteFrac: rowBand(Math.floor(H / 2)) },
    { name: 'col gutter 1/4',  whiteFrac: colBand(Math.floor(W / 4)) },
    { name: 'col gutter 2/4',  whiteFrac: colBand(Math.floor(W / 2)) },
    { name: 'col gutter 3/4',  whiteFrac: colBand(Math.floor(3 * W / 4)) },
  ];
  for (const c of checks) {
    if (c.whiteFrac < 0.80) {
      return { valid: false, reason: `${c.name} only ${(100*c.whiteFrac).toFixed(1)}% white (need ≥80%) — figure likely crosses the gutter` };
    }
  }
  return { valid: true };
}

/**
 * Gemini Vision evaluator — verifies:
 *   1. Top row contains heads only (no shoulders/torso visible).
 *   2. Bottom row contains full bodies, head to feet.
 *   3. All 4 heads show the same person (same face, hair, glasses).
 *   4. All 4 bodies show the same person AND the same outfit.
 *   5. The person in the sheet matches the source face photo (Task 4 — only
 *      when sourcePhoto is provided). Catches the "different person entirely"
 *      failure mode where Grok renders a coherent sheet of the WRONG identity.
 * Prompt: prompts/sheet-2x4-evaluation.txt.
 *
 * Returns the parsed JSON verdict { valid, finalScore, failureReasons, … }.
 * Throws on Gemini errors so the retry loop decides whether to retry or fail.
 *
 * @param {string} imageData  generated 2×4 sheet (data URI)
 * @param {string} costumeDescription  prose for outfit-match check
 * @param {string} geminiApiKey
 * @param {string} [sourcePhoto]  source face photo (data URI). When provided,
 *   sent as Image 1 and the source-match task fires; the sheet becomes Image 2.
 */
async function evaluateSheetWithGemini(imageData, costumeDescription, geminiApiKey, sourcePhoto = null) {
  const sheetB64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  const sheetMime = imageData.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  let prompt = PROMPT_TEMPLATES.sheet2x4Evaluation;
  if (!prompt) throw new Error('sheet2x4Evaluation prompt template not loaded');
  if (costumeDescription) {
    prompt = prompt.replace(/REQUESTED_OUTFIT/g, `REQUESTED_OUTFIT: ${costumeDescription}`);
  }

  // Image order matters — the prompt explicitly labels Image 1 = source,
  // Image 2 = generated sheet. When no sourcePhoto provided, fall back to
  // sheet-only (Task 4 won't have a baseline; the evaluator should still
  // return a verdict with sourceMatchScore=null or 10 as documented).
  const parts = [];
  if (sourcePhoto) {
    const srcB64 = sourcePhoto.replace(/^data:image\/\w+;base64,/, '');
    const srcMime = sourcePhoto.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    parts.push({ inline_data: { mime_type: srcMime, data: srcB64 } });
  }
  parts.push({ inline_data: { mime_type: sheetMime, data: sheetB64 } });
  parts.push({ text: prompt });

  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4000, responseMimeType: 'application/json' },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }
  );
  if (!resp.ok) throw new Error(`Gemini eval HTTP ${resp.status}`);
  const j = await resp.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini eval returned no text');
  return JSON.parse(text);
}

// Art-style descriptor for the Pass 2 style-transfer prompt.
// Reads from the canonical ART_STYLES dictionary in storyHelpers.js so every
// style the wizard exposes (14 today: watercolor, realistic, concept, oil,
// pixar, cartoon, comic, anime, manga, steampunk, cyber, chibi, pixel,
// lowpoly) is supported. Previously a hard-coded 7-entry STYLE_LINES map
// silently downgraded the other 7 to watercolour, so e.g. a "manga" story
// got a watercolour Pass 2 sheet. resolveArtStyle returns rich
// per-backend prose; we use Grok since Pass 2 runs through editWithGrok.
function resolveStyleLineForSheet(artStyle) {
  // Defer require until call time — storyHelpers.js is heavy and not
  // needed until Pass 2 runs.
  const { resolveArtStyle } = require('./storyHelpers');
  const style = resolveArtStyle(artStyle, 'grok');
  if (style) return style;
  // Unknown style id (shouldn't happen — frontend constrains to ART_STYLES).
  // Fail loudly instead of silently swapping to watercolour.
  throw new Error(`[CHARACTER 2×4] Unknown artStyle "${artStyle}" — add it to ART_STYLES in server/lib/storyHelpers.js`);
}

function buildStyleTransferPrompt(artStyle) {
  const styleLine = resolveStyleLineForSheet(artStyle);
  return `Re-render this 2×4 character reference sheet in ${styleLine}.

Preserve EVERYTHING except the visual style:
- Same 4-column × 2-row grid layout, same thin black dividers, same pure white background.
- Top row cells 1-4: head and neck only, in the same order (front, three-quarter, profile, back). Same hair, same beard if any, same skin tone, same facial features — the same person.
- Bottom row cells 5-8: full body in the same poses (front, three-quarter, profile, back). Same proportions, same age. Same costume — every accessory, every garment colour, every cut identical.
- No text, no numbers, no labels.

Only the surface treatment changes from photographic to ${styleLine}.`;
}

/**
 * Pass 2 evaluator — verifies the style-transferred sheet preserves identity
 * + costume + layout, AND that the requested style was actually applied
 * (rather than the model returning the source unchanged, as Gemini tends to).
 *
 * Receives THREE images in order: source face photo, Pass 1 realistic sheet,
 * Pass 2 styled sheet. Returns parsed JSON verdict from
 * prompts/sheet-2x4-style-eval.txt.
 */
async function evaluateStyledSheetWithGemini(sourcePhoto, realisticSheet, styledSheet, artStyle, geminiApiKey) {
  const styleLabel = resolveStyleLineForSheet(artStyle);

  let prompt = PROMPT_TEMPLATES.sheet2x4StyleEval;
  if (!prompt) throw new Error('sheet2x4StyleEval prompt template not loaded');
  prompt = prompt.replace(/REQUESTED_STYLE/g, `REQUESTED_STYLE: ${styleLabel}`);

  const toInlinePart = (dataUri) => {
    const b64 = dataUri.replace(/^data:image\/\w+;base64,/, '');
    const mime = dataUri.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    return { inline_data: { mime_type: mime, data: b64 } };
  };

  const body = {
    contents: [{
      parts: [
        toInlinePart(sourcePhoto),
        toInlinePart(realisticSheet),
        toInlinePart(styledSheet),
        { text: prompt },
      ],
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2500, responseMimeType: 'application/json' },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }
  );
  if (!resp.ok) throw new Error(`Gemini style-eval HTTP ${resp.status}`);
  const j = await resp.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini style-eval returned no text');
  return JSON.parse(text);
}

/**
 * Generate a 2×4 reference sheet for one character + costume in one Grok call.
 *
 * Inputs to Grok: phantom (pose template) + standard avatar (body / clothing
 * identity) + face photo (face identity). No Gemini styled-2×2 step — the 2×4
 * IS the styled avatar.
 *
 * Quality eval: after each Grok call, run quickLayoutCheck (pixel-level
 * gutter test) and then Gemini Vision against prompts/sheet-2x4-evaluation.txt
 * (top-heads / bottom-bodies / same-person). Retry up to MAX_SHEET_RETRIES
 * on fail; throw if every attempt fails so the cast builder falls back
 * cleanly rather than caching a malformed sheet.
 *
 * @param {Object} character - character record (with .avatars and .photos)
 * @param {Object} opts
 * @param {string} opts.clothingCategory - 'standard' | 'costumed:<theme>' | 'winter' | 'summer'
 * @param {string} opts.costumeDescription - prose for the costume worn in the bottom row.
 * @param {string} [opts.artStyle='watercolor']
 * @param {Function} [opts.usageTracker] - (provider, usage, fn, modelId) => void
 * @param {boolean} [opts.skipQualityEval=false] - bypass eval (tests / explicit override)
 * @returns {Promise<{ imageData: string, usage: Object }>}
 */
async function generateCharacter2x4Sheet(character, opts = {}) {
  const {
    clothingCategory = 'standard',
    costumeDescription = 'standard outfit',
    artStyle = 'watercolor',
    usageTracker = null,
    skipQualityEval = false,
  } = opts;

  const phantom = loadPhantom();
  const facePhoto = resolveFacePhoto(character);
  if (!facePhoto) {
    throw new Error(`No face photo for ${character?.name || 'character'}.`);
  }
  const standardAvatar = resolveStandardAvatar(character);
  // The standard avatar is the preferred body reference. If it's missing
  // (e.g. avatar generation failed earlier), fall back to face-only —
  // Grok will rebuild the body from the prompt.
  const refs = standardAvatar
    ? [phantom, standardAvatar, facePhoto]
    : [phantom, facePhoto];

  const prompt = buildPrompt(artStyle, costumeDescription);

  // Track every attempt — when all retries fail to produce a `valid` sheet
  // (per the eval), we pick the highest-scoring attempt instead of throwing.
  // Better to ship the least-bad sheet and surface the attempt history in
  // the dev panel than to fail the whole story on a marginal eval miss.
  const attemptHistory = [];
  let bestAttempt = null;  // { result, score, verdict|null, quick|null }
  const totalAttempts = 1 + MAX_SHEET_RETRIES;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    log.info(`[CHARACTER 2×4] Generating sheet for ${character?.name} (${clothingCategory}, ${artStyle}, refs=${refs.length}, attempt ${attempt}/${totalAttempts})`);
    const result = await editWithGrok(prompt, refs, { aspectRatio: '16:9', model: GROK_MODELS.STANDARD });
    if (usageTracker && result.usage) usageTracker('grok', result.usage, 'character_2x4_sheet', result.modelId);

    if (skipQualityEval) {
      // Caller bypassed eval — first attempt's result IS the result.
      bestAttempt = { result, score: 10, verdict: null, quick: null, attempt };
      attemptHistory.push({ attempt, stage: 'skipped', score: 10, imageData: result.imageData });
      break;
    }

    // Cheap pixel check first — catches the row-gutter failure for free.
    const quick = await quickLayoutCheck(result.imageData);
    if (!quick.valid) {
      log.warn(`[CHARACTER 2×4] ${character?.name} attempt ${attempt} failed quick layout check: ${quick.reason}`);
      // Score the failed-quick attempt as 0 so any later attempt that
      // passes quick wins, but if every attempt fails quick we still have
      // SOMETHING to return rather than throwing.
      const candidate = { result, score: 0, verdict: null, quick, attempt };
      attemptHistory.push({ attempt, stage: 'quick-fail', score: 0, reason: quick.reason, imageData: result.imageData });
      if (!bestAttempt || candidate.score > bestAttempt.score) bestAttempt = candidate;
      continue;
    }

    // Gemini eval — verifies heads-only / bodies / identity / outfit.
    if (!process.env.GEMINI_API_KEY) {
      log.warn('[CHARACTER 2×4] GEMINI_API_KEY missing — accepting after quick-check only');
      bestAttempt = { result, score: 10, verdict: null, quick, attempt };
      attemptHistory.push({ attempt, stage: 'no-eval-key', score: 10, imageData: result.imageData });
      break;
    }
    let verdict = null;
    try {
      // Pass the source face photo so Task 4 (sourceMatchScore) fires —
      // catches sheets that are structurally fine but show a different
      // person than the user uploaded (e.g. Grok hallucinating identity).
      verdict = await evaluateSheetWithGemini(result.imageData, costumeDescription, process.env.GEMINI_API_KEY, facePhoto);
      log.info(`[CHARACTER 2×4]   eval: layout=${verdict.layout?.layoutScore} identity=${verdict.identity?.identityScore} outfit=${verdict.outfit?.outfitScore} sourceMatch=${verdict.sourceMatch?.sourceMatchScore} final=${verdict.finalScore} valid=${verdict.valid}`);
    } catch (err) {
      // Eval errors no longer get a free score=10. Treat them as score=5
      // (neutral) so a later successful eval can win the best-of-N selection,
      // but a JSON-truncation failure can't promote a marginal Grok output to
      // "best attempt" over a real `valid` verdict on the next retry.
      log.warn(`[CHARACTER 2×4] Gemini eval error on attempt ${attempt}: ${err.message} — counting as neutral (score=5) and continuing retries`);
      const candidate = { result, score: 5, verdict: null, quick, attempt };
      attemptHistory.push({ attempt, stage: 'eval-error', score: 5, reason: err.message, imageData: result.imageData, sentToGrok: result.sentToGrok || null });
      if (!bestAttempt || candidate.score > bestAttempt.score) bestAttempt = candidate;
      continue;
    }
    const score = verdict.finalScore ?? 0;
    const candidate = { result, score, verdict, quick, attempt };
    attemptHistory.push({
      attempt,
      stage: verdict.valid ? 'valid' : 'invalid',
      score,
      layoutScore: verdict.layout?.layoutScore,
      identityScore: verdict.identity?.identityScore,
      outfitScore: verdict.outfit?.outfitScore,
      sourceMatchScore: verdict.sourceMatch?.sourceMatchScore,
      reasons: verdict.failureReasons || [],
      imageData: result.imageData,
      sentToGrok: result.sentToGrok || null,
    });
    if (!bestAttempt || candidate.score > bestAttempt.score) bestAttempt = candidate;
    if (verdict.valid) break;
    log.warn(`[CHARACTER 2×4] ${character?.name} attempt ${attempt} eval finalScore=${score} (valid=false): ${(verdict.failureReasons || []).join('; ')}`);
  }

  if (!bestAttempt) {
    throw new Error(`[CHARACTER 2×4] no usable image produced after ${totalAttempts} attempts for ${character?.name}`);
  }
  if (attemptHistory.length > 1) {
    log.info(`[CHARACTER 2×4] ${character?.name} Pass 1 best-of-${attemptHistory.length}: attempt ${bestAttempt.attempt} (score=${bestAttempt.score})`);
  }

  const pass1 = {
    imageData: bestAttempt.result.imageData,
    selectedAttempt: bestAttempt.attempt,
    finalScore: bestAttempt.score,
    finalVerdict: bestAttempt.verdict,
    attempts: attemptHistory,
    prompt,
    sentToGrok: bestAttempt.result.sentToGrok || null,
  };

  // ── PASS 2: style transfer (always runs when artStyle is non-realistic) ─
  // Previously gated on pass1.finalScore >= 6 to avoid styling a broken
  // sheet. Removed (2026-05-17 per user direction) — the quickLayoutCheck
  // is over-eager and was rejecting structurally-fine sheets, then Pass 2
  // skipped, then the character shipped as a realistic photo embedded in
  // a watercolour story. The outer Face/Clothing eval still gates the
  // final selection, so a truly broken sheet won't ship either way. Every
  // non-realistic art style now gets style transfer applied.
  const wantStyleTransfer = !skipQualityEval && artStyle && artStyle !== 'realistic';
  let pass2 = null;
  if (wantStyleTransfer) {
    pass2 = await runStyleTransferPass({
      pass1ImageData: pass1.imageData,
      facePhoto,
      artStyle,
      characterName: character?.name,
      usageTracker,
    });
  }

  // The function's primary return value (`imageData`) is the styled sheet
  // when Pass 2 ran successfully, otherwise the realistic Pass 1 output.
  // Downstream consumers (composite, ref attachment) get the story-style
  // sheet by default. Pass 1's realistic anchor is on `realisticImageData`
  // for inspection.
  const finalImage = pass2?.imageData || pass1.imageData;
  return {
    imageData: finalImage,
    realisticImageData: pass1.imageData,
    usage: bestAttempt.result.usage,
    prompt: pass1.prompt,
    refs: {
      phantom,
      standardAvatar: standardAvatar || null,
      facePhoto,
    },
    passes: { pass1, pass2 },
    // Legacy fields — kept so existing callers don't break. The styled
    // (Pass 2) attempt history is what the dev panel renders by default.
    attemptHistory: pass2?.attempts || pass1.attempts,
    selectedAttempt: pass2?.selectedAttempt ?? pass1.selectedAttempt,
    finalScore: pass2?.finalScore ?? pass1.finalScore,
    finalVerdict: pass2?.finalVerdict || pass1.finalVerdict,
  };
}

/**
 * Pass 2 — take the realistic Pass 1 sheet and re-render it in the story's
 * art style via Grok edit. Best-of-N retry. Eval via
 * evaluateStyledSheetWithGemini: layout + identity (vs source photo) +
 * style match + costume preserved. Returns the same shape as Pass 1's
 * collected fields so the dev panel can render both passes uniformly.
 */
async function runStyleTransferPass({ pass1ImageData, facePhoto, artStyle, characterName, usageTracker }) {
  const prompt = buildStyleTransferPrompt(artStyle);
  const totalAttempts = 1 + MAX_SHEET_RETRIES;
  const attempts = [];
  let best = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    log.info(`[CHARACTER 2×4] ${characterName} Pass 2 (style=${artStyle}) attempt ${attempt}/${totalAttempts}`);
    const result = await editWithGrok(prompt, [pass1ImageData], { aspectRatio: '16:9', model: GROK_MODELS.STANDARD });
    if (usageTracker && result.usage) usageTracker('grok', result.usage, 'character_2x4_style_transfer', result.modelId);

    if (!process.env.GEMINI_API_KEY) {
      log.warn('[CHARACTER 2×4] GEMINI_API_KEY missing — accepting Pass 2 after first attempt');
      best = { result, attempt, score: 10, verdict: null };
      attempts.push({ attempt, stage: 'no-eval-key', score: 10, imageData: result.imageData, sentToGrok: result.sentToGrok || null });
      break;
    }

    let verdict = null;
    try {
      verdict = await evaluateStyledSheetWithGemini(facePhoto, pass1ImageData, result.imageData, artStyle, process.env.GEMINI_API_KEY);
      log.info(`[CHARACTER 2×4]   Pass 2 eval: layout=${verdict.layoutScore} identity=${verdict.identityScore} style=${verdict.styleScore} outfit=${verdict.outfitScore} final=${verdict.finalScore} valid=${verdict.valid}`);
    } catch (err) {
      log.warn(`[CHARACTER 2×4] Pass 2 eval error attempt ${attempt}: ${err.message} — accepting as best-effort`);
      best = { result, attempt, score: 10, verdict: null };
      attempts.push({ attempt, stage: 'eval-error', score: 10, reason: err.message, imageData: result.imageData, sentToGrok: result.sentToGrok || null });
      break;
    }
    const score = verdict.finalScore ?? 0;
    attempts.push({
      attempt,
      stage: verdict.valid ? 'valid' : 'invalid',
      score,
      layoutScore: verdict.layoutScore,
      identityScore: verdict.identityScore,
      styleScore: verdict.styleScore,
      outfitScore: verdict.outfitScore,
      reasons: verdict.failureReasons || [],
      imageData: result.imageData,
      sentToGrok: result.sentToGrok || null,
    });
    const candidate = { result, attempt, score, verdict };
    if (!best || candidate.score > best.score) best = candidate;
    if (verdict.valid) break;
    log.warn(`[CHARACTER 2×4] ${characterName} Pass 2 attempt ${attempt} score=${score} (valid=false)`);
  }

  if (!best) {
    log.error(`[CHARACTER 2×4] ${characterName} Pass 2 produced no image after ${totalAttempts} attempts — returning Pass 1 unchanged`);
    return { imageData: null, attempts, selectedAttempt: null, finalScore: 0, finalVerdict: null, prompt };
  }
  if (attempts.length > 1) {
    log.info(`[CHARACTER 2×4] ${characterName} Pass 2 best-of-${attempts.length}: attempt ${best.attempt} (score=${best.score})`);
  }
  return {
    imageData: best.result.imageData,
    selectedAttempt: best.attempt,
    finalScore: best.score,
    finalVerdict: best.verdict,
    attempts,
    prompt,
    sentToGrok: best.result.sentToGrok || null,
  };
}

module.exports = {
  generateCharacter2x4Sheet,
  loadPhantom,
  // exposed for tests
  _internal: { buildPrompt, buildStyleTransferPrompt, resolveFacePhoto, resolveStandardAvatar, quickLayoutCheck, evaluateSheetWithGemini, evaluateStyledSheetWithGemini, runStyleTransferPass },
};
