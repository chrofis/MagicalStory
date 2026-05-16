/**
 * Character 2×4 reference sheet generator (variant A).
 *
 * Generates one 8-cell sheet per character per costume:
 *   - Top row (cells 1–4): face front / 45° / profile / back-of-head
 *   - Bottom row (cells 5–8): full body at the same four angles, costumed
 *
 * Inputs:
 *   - phantom (the pose template — bundled at server/assets/phantom-watercolor.png)
 *   - styled 2×2 avatar (existing production output from generateStyledCostumedAvatar)
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

// Art-style descriptors injected into the 2×4 generation prompt so the sheet
// renders in the story's chosen style. MUST stay aligned with
// sceneComposite.js BLEND_STYLE_LINES — the blend step uses the same
// descriptors so the page-level art lands on the same surface treatment as
// the character sheet. Adult-figure stories rely on this: "cartoon" without
// the descriptor leaves Grok free to invent chibi proportions on an adult
// face (see staging story job_1778881997472 page 1 — Daniel rendered as
// chibi-bodied 68-year-old).
const ART_STYLE_LINES = {
  watercolor: "soft watercolor children's storybook illustration style — gentle washes, simple outlines, realistic adult proportions for adult characters",
  pixar:      "Pixar 3D illustration style — smooth shading, clean rim light, age-appropriate body proportions (no chibi heads on adult bodies)",
  anime:      "anime line-art style — clean lines, flat shading, age-appropriate body proportions",
  cartoon:    "modern flat cartoon — bold outlines, clean shapes, age-appropriate body proportions (adults have full adult proportions, NOT chibi)",
  oil:        "oil painting style with visible brushwork, realistic age-appropriate proportions",
};

function buildPrompt(artStyle, costumeDescription) {
  const styleLine = ART_STYLE_LINES[artStyle] || ART_STYLE_LINES.watercolor;
  return `Image 1 indicates only the camera angle and facing direction in each cell — ignore its silhouette, body, and face.
Image 2 is the character's body. Image 3 is the character's face.

Costume: ${costumeDescription}

Render every cell in ${styleLine}.

Output a 2×4 grid with thin black dividing lines and pure white background, in the same cell layout as Image 1.

Cells 1-4 (top row): head and neck only, no shoulders, no clothing. Cell 1 front, cell 2 three-quarter, cell 3 profile, cell 4 back of head.
Cells 5-8 (bottom row): full body from head to feet wearing the costume. Cell 5 front, cell 6 three-quarter, cell 7 profile, cell 8 back.

Every cell faces in the same direction as the matching cell in Image 1. The same costume — every accessory — appears in cells 5, 6, 7, and 8. The body in cells 5-8 keeps the proportions of the person in Image 3 (the face photo) — match the apparent age. No text, no numbers, no labels.`;
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
    generationConfig: { temperature: 0.2, maxOutputTokens: 2000, responseMimeType: 'application/json' },
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
      log.warn(`[CHARACTER 2×4] Gemini eval error on attempt ${attempt}: ${err.message} — treating as best-effort accept`);
      bestAttempt = { result, score: 10, verdict: null, quick, attempt };
      attemptHistory.push({ attempt, stage: 'eval-error', score: 10, reason: err.message, imageData: result.imageData });
      break;
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
      reasons: verdict.failureReasons || [],
      imageData: result.imageData,
    });
    if (!bestAttempt || candidate.score > bestAttempt.score) bestAttempt = candidate;
    if (verdict.valid) break;
    log.warn(`[CHARACTER 2×4] ${character?.name} attempt ${attempt} eval finalScore=${score} (valid=false): ${(verdict.failureReasons || []).join('; ')}`);
  }

  if (!bestAttempt) {
    throw new Error(`[CHARACTER 2×4] no usable image produced after ${totalAttempts} attempts for ${character?.name}`);
  }
  if (attemptHistory.length > 1) {
    log.info(`[CHARACTER 2×4] ${character?.name} best-of-${attemptHistory.length}: attempt ${bestAttempt.attempt} (score=${bestAttempt.score})`);
  }

  return {
    imageData: bestAttempt.result.imageData,
    usage: bestAttempt.result.usage,
    prompt,
    refs: {
      phantom,
      standardAvatar: standardAvatar || null,
      facePhoto,
    },
    // Surfaced so the dev panel can show all attempts side-by-side with
    // their eval scores. The chosen attempt has `score === bestAttempt.score`.
    attemptHistory,
    selectedAttempt: bestAttempt.attempt,
    finalScore: bestAttempt.score,
    finalVerdict: bestAttempt.verdict,
  };
}

module.exports = {
  generateCharacter2x4Sheet,
  loadPhantom,
  // exposed for tests
  _internal: { buildPrompt, resolveFacePhoto, resolveStandardAvatar, quickLayoutCheck, evaluateSheetWithGemini },
};
