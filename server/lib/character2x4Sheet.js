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
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { MODEL_DEFAULTS } = require('../config/models');
const r2 = require('./r2');
const { getFacePhoto, getStandardAvatar } = require('./characterPhotos');

// Minimal Gemini image-edit for the avatar style-transfer pass. Same contract
// as editWithGrok (prompt + reference images → { imageData, usage, modelId }).
// Gemini stylises far better than Grok on this BIG transform (all-5 A/B,
// project_image_model_tests.md 2026-07-19); Grok stays on Round 1 (identity).
async function editWithGeminiImage(prompt, refImages, { aspectRatio = '16:9', model = 'gemini-2.5-flash-image' } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing for avatar style transfer');
  const parts = [{ text: prompt }, ...refImages.map(img => ({
    inlineData: { mimeType: (String(img).match(/^data:(image\/\w+);base64,/)?.[1]) || 'image/jpeg', data: r2.stripDataUriPrefix(img) },
  }))];
  const body = { contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], temperature: 0.8, imageConfig: { aspectRatio } } };
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  if (!resp.ok) throw new Error(`Gemini image HTTP ${resp.status}: ${(await resp.text()).slice(0, 150)}`);
  const j = await resp.json();
  const part = (j?.candidates?.[0]?.content?.parts || []).find(p => p.inlineData || p.inline_data);
  const inline = part?.inlineData || part?.inline_data;
  if (!inline) throw new Error('Gemini returned no image (style transfer)');
  const usage = j?.usageMetadata ? { input_tokens: j.usageMetadata.promptTokenCount || 0, output_tokens: j.usageMetadata.candidatesTokenCount || 0 } : null;
  return { imageData: 'data:image/jpeg;base64,' + inline.data, usage, modelId: model, sentToGrok: refImages };
}

// Dispatch the Round-2 style transfer to the configured backend.
// `backendOverride` ('gemini' | 'grok') bypasses MODEL_DEFAULTS for ONE call —
// used by the alternate-engine retry in runStyleTransferPass when every
// attempt on the configured backend failed (e.g. Gemini IMAGE_OTHER safety
// refusal on an adult-face sheet). Model IDs never cross providers: each
// branch resolves its own provider's model.
// Nearest supported aspect preset for an image, so style transfer OUTPUTS the
// same shape as its input instead of squeezing it. The decoupled composite is
// ~square (two stacked 16:9 rows); forcing 16:9 here cropped the heads and
// compressed the bodies. Gemini/Grok only take preset strings, so the composite
// is built to an exact preset (1:1, padded — see stackRowsInto2x4) and this
// returns that preset back.
async function aspectPresetFor(imageData) {
  try {
    const buf = Buffer.from(r2.stripDataUriPrefix(imageData), 'base64');
    const { width, height } = await sharp(buf).metadata();
    const r = width / height;
    const presets = [['1:1', 1], ['3:4', 0.75], ['4:3', 4 / 3], ['9:16', 0.5625], ['16:9', 16 / 9]];
    return presets.reduce((best, p) => Math.abs(p[1] - r) < Math.abs(best[1] - r) ? p : best)[0];
  } catch { return '16:9'; }
}

async function styleTransferGenerate(prompt, pass1ImageData, backendOverride = null, styleAnchor = null) {
  const backend = backendOverride || MODEL_DEFAULTS.avatarStyleTransferBackend;
  const aspectRatio = await aspectPresetFor(pass1ImageData); // aspect follows the sheet, not the anchor
  // Image 1 = the sheet to repaint; Image 2 (when present) = the style anchor
  // referenced by buildStyleTransferPrompt ("Image 2 is a reference of that art style").
  const refs = styleAnchor ? [pass1ImageData, styleAnchor] : [pass1ImageData];
  if (backend === 'gemini') {
    const r = await editWithGeminiImage(prompt, refs, { aspectRatio, model: MODEL_DEFAULTS.avatarStyleTransferModel });
    return { ...r, provider: 'gemini_image' };
  }
  const r = await editWithGrok(prompt, refs, { aspectRatio, model: GROK_MODELS.STANDARD });
  return { ...r, provider: 'grok' };
}

// Best-of-N cap: first attempt + N retries. The loop short-circuits on the
// first valid eval — retries only fire when an attempt fails. If all attempts
// fail, we pick the best and ship it. Two retries = up to 3 Grok calls per pass.
// Max 1 retry per stage (user direction 2026-08-09). Pass 1 (body/head rows)
// hardcodes ≤2 tries each inside generateComposited2x4; this governs Pass 2
// (style transfer) → 1 + 1 = 2 attempts.
const MAX_SHEET_RETRIES = 1;

const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
// The -axes variants overlay a 3-axis RGB gizmo (red X / green Y / blue Z)
// on the face region of every cell instead of the original eye-dots + mouth
// line. Grok was copying the smooth featureless face from the original
// phantom into renders ("phantom face leak"); the gizmo is unmistakably
// non-anatomical so it gets ignored while still communicating head angle.
// See docs/decisions.md → "Phantom face replaced with RGB axis-gizmo overlay".
const DEFAULT_PHANTOM_PATH = path.join(ASSETS_DIR, 'phantom-watercolor-axes.png');
// Resolved-file-path → data URL. Each age tier is a distinct reusable asset
// generated once (scripts/generate-phantom-age-tiers.js) so its proportions
// can be cached independently.
const phantomCache = new Map();

// Map a character's declared age to a phantom tier. The phantom's head-to-body
// ratio leaks into the rendered character despite the "ignore the body" prompt,
// so the tier must match the character's age (toddler≈4, child≈5.5, teen≈7,
// adult≈7.5 head-heights). Unknown/unparseable age defaults to 'child' — the
// product is overwhelmingly for kids, so an unknown-age fallback to an
// adult-proportioned generic phantom (the previous behaviour) produced
// adult-looking renders for trial users who skipped the optional age field.
function phantomTierForAge(age) {
  const n = parseInt(age, 10);
  if (!Number.isFinite(n) || n < 0) return 'child';
  if (n <= 4) return 'toddler';
  if (n <= 11) return 'child';
  if (n <= 17) return 'teen';
  return 'adult';
}

function loadPhantom(age) {
  const tier = phantomTierForAge(age);
  const tierPath = tier ? path.join(ASSETS_DIR, `phantom-watercolor-${tier}-axes.png`) : null;
  // Prefer the age-tier phantom; fall back to the default when its asset
  // isn't bundled yet, so behaviour is unchanged until the tiers land.
  const file = (tierPath && fs.existsSync(tierPath)) ? tierPath : DEFAULT_PHANTOM_PATH;
  if (phantomCache.has(file)) return phantomCache.get(file);
  if (!fs.existsSync(file)) {
    throw new Error(`Phantom asset missing at ${file}. Run scripts/test-phantom-generate.js and copy the output here.`);
  }
  const buf = fs.readFileSync(file);
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  phantomCache.set(file, dataUrl);
  // Include file basename + byte size so the user can verify via the dev
  // panel which phantom was actually used. Each tier has a distinct
  // size — -axes variants run ~360–728 KB depending on tier.
  log.info(`[2x4-SHEET] age ${age}→${tier || 'default'} phantom — loaded ${path.basename(file)} (${Math.round(buf.length / 1024)} KB)`);
  return dataUrl;
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
//
// Build a HAIR block from character.physical when populated. Without this,
// the prompt only said "same hair" and trusted Grok to extract everything
// from the Image 3 face crop. That works when the face crop is loose enough
// to show full hair shape; it fails when the crop is tight to the face or
// the back-of-head cell (#4) needs to be invented from scratch. The hair
// fields are populated by trial.js:737-745 (Gemini photo analysis) and
// stamped onto character.physical — they're free text the sheet prompt
// can just paste in.
function buildHairBlock(character) {
  const p = character?.physical || {};
  const hairBits = [];
  if (p.hairColor) hairBits.push(`Hair color: ${p.hairColor}.`);
  // detailedHairAnalysis is a structured object on trial photos (texture/
  // type/length/styling/parting/colorHex). Spell out the load-bearing
  // fields for Grok rather than dumping the JSON — terse imperatives
  // weight better than free-form prose.
  if (p.detailedHairAnalysis && typeof p.detailedHairAnalysis === 'object') {
    const h = p.detailedHairAnalysis;
    const detail = [];
    if (h.type)        detail.push(h.type);                 // straight | wavy | curly | coily
    if (h.lengthTop)   detail.push(`top length ${h.lengthTop}`);
    if (h.lengthSides) detail.push(`sides ${h.lengthSides}`);
    if (h.bangsEndAt && h.bangsEndAt !== 'no bangs') detail.push(`bangs ${h.bangsEndAt}`);
    if (h.styling)     detail.push(`styled ${h.styling}`);
    if (h.parting && h.parting !== 'none') detail.push(h.parting);
    if (detail.length) hairBits.push(`Hairstyle: ${detail.join(', ')}.`);
  } else if (typeof p.detailedHairAnalysis === 'string' && p.detailedHairAnalysis.trim()) {
    hairBits.push(`Hairstyle: ${p.detailedHairAnalysis.trim()}.`);
  }
  if (!hairBits.length) return '';
  return `\n${hairBits.join(' ')} Reproduce the hair EXACTLY in every cell — same length, same color, same shape, same parting. The back-of-head cell (cell 4) must show the same hair from behind. Do NOT invent a different cut.\n`;
}

// ── Decoupled two-call sheet generation (2026-08-08) ────────────────────────
// ONE combined 2×4 edit produced a HEADLESS bottom (body) row ~70% of the time:
// squeezed into the near-square bottom cells the model rendered the two rows as
// one tall figure and cropped the head off the bottom half. Reproduced 7/10 with
// identical params (not variance); the axes-vs-headed phantom made no difference.
// Fix: two calls — (1) a dedicated 1×4 FULL-BODY row with TALL cells, then (2) a
// 1×4 HEAD-SHOT row that references the just-rendered body so the heads belong to
// it — composited into the 2×4. Validated: body call 0/15 headless, head call
// good identity + quality (a fresh render beats crop-and-scale). Grok edit takes
// only 3 refs; the head call uses [mannequin heads, face photo, body row].
// See docs/decisions.md (decoupled-avatar-sheet).

// Load an age-tier phantom in the requested variant: 'axes' (arrow direction
// guides — used for the head-shot row) or 'plain' (no arrows, headed bottom
// mannequins — used for the body row). Same tier-fallback as loadPhantom.
function loadPhantomVariant(age, variant) {
  const tier = phantomTierForAge(age);
  const suffix = variant === 'axes' ? '-axes' : '';
  const tierPath = path.join(ASSETS_DIR, `phantom-watercolor-${tier}${suffix}.png`);
  const fallback = variant === 'axes' ? DEFAULT_PHANTOM_PATH : path.join(ASSETS_DIR, 'phantom-watercolor-adult.png');
  const file = fs.existsSync(tierPath) ? tierPath : fallback;
  if (phantomCache.has(file)) return phantomCache.get(file);
  if (!fs.existsSync(file)) throw new Error(`Phantom asset missing at ${file}`);
  const dataUrl = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  phantomCache.set(file, dataUrl);
  return dataUrl;
}

// Crop a phantom into its top (head) row and bottom (body) row at the mid line.
async function phantomRow(phantomDataUrl, which) {
  const buf = Buffer.from(r2.stripDataUriPrefix(phantomDataUrl), 'base64');
  const { width, height } = await sharp(buf).metadata();
  const mid = Math.round(height / 2);
  const region = which === 'top'
    ? { left: 0, top: 0, width, height: mid }
    : { left: 0, top: mid, width, height: height - mid };
  const out = await sharp(buf).extract(region).png().toBuffer();
  return `data:image/png;base64,${out.toString('base64')}`;
}

// Body-row prompt (call 1): one row of 4 full bodies, tall cells. Keeps the
// outer layer in the profile (validated wording). Generic — no story specifics.
function buildBodyRowPrompt(costumeDescription, character = null, redress = false, costumeName = null) {
  const hairBlock = buildHairBlock(character);
  const bodyRef = redress
    ? `Image 2 shows the character's body shape, build, and identity ONLY — IGNORE the clothing in Image 2, it is the wrong outfit. Image 3 is the character's face.`
    : `Image 2 is the character's body. Image 3 is the character's face.`;
  // The costume NAME, not just its garments. Without it the model gets a bare
  // garment list and renders each item by its most common association — a cloth
  // head wrap on a small child reads as a headband bow, not as pirate headwear.
  const named = costumeName ? ` — a ${costumeName}` : '';
  const outfitRule = redress
    ? `Costume${named} (the ONLY outfit — every cell wears exactly this, NOT the clothing from Image 2): ${costumeDescription}`
    : `Costume${named}: ${costumeDescription}`;
  const readsAs = costumeName ? `
The figure reads as a ${costumeName} at a glance. Each garment is worn the way that costume wears it.` : '';
  return `Image 1 indicates only the camera angle and facing direction in each cell — ignore its silhouette, body, and face. The output contains no arrows.
${bodyRef}

${outfitRule}${readsAs}${hairBlock}
Render every cell as a REALISTIC reference — the same visual style as the source face photo in Image 3. Photographic / lifelike, natural proportions matching the person's apparent age in Image 3. No cartoon, no anime, no watercolour. This sheet is an identity anchor.

Output a 1×4 grid: ONE row, four cells side by side, thin black vertical dividers, pure white background, same cell layout as Image 1.
Each cell shows the SAME PERSON as Image 3 rendered as a COMPLETE FULL BODY from the very top of the head to the figure's lowest point, wearing the costume. Cell 1 front, cell 2 three-quarter, cell 3 profile, cell 4 back. Normally that lowest point is both feet with shoes, and the whole figure — head, hair, face, torso, legs, feet — sits inside its cell. When the costume replaces the legs (a tail, a fin, a single fused lower body), the figure has NO legs, NO feet and NO footwear: it ends at the tip of that form, which is then the lowest point. Never crop the head and never crop the lowest point; if the figure does not fit, scale it down until the whole figure is inside the cell, with white margin above and below. Body proportions match the person's apparent age (an adult is roughly 7 to 8 heads tall).
The outfit is identical in all four cells, layers included. When the costume has an outer layer — vest, jacket, cardigan, coat, or overshirt — it stays on in the profile and back cells. Seen edge-on in the profile, its front opening runs as a vertical band down the side of the torso, with the shoulder seam, armhole, and the back panel visible behind the arm. No text, numbers, labels, arrows, or symbols anywhere.`;
}

// Head-row prompt (call 2): one row of 4 head-shots that match the body sheet.
// Refs: Image 1 = mannequin head row (angles), Image 2 = face photo (identity),
// Image 3 = the body row from call 1 (match its rendered face/hair).
function buildHeadRowPrompt(character = null) {
  const hairBlock = buildHairBlock(character);
  return `Image 1 shows the four camera angles for a head-shot row — use it ONLY for facing direction (cell 1 front, cell 2 three-quarter, cell 3 profile, cell 4 back of head); ignore its face and features, and never draw arrows.
Image 2 is the character's face photo — the identity; match this exact face.
Image 3 is the character's full-body reference sheet — match the SAME face, hair colour, hairstyle, and skin tone shown there so the heads belong to that body.${hairBlock}
Output a 1×4 grid: ONE row, four cells side by side, thin black vertical dividers, pure white background. Each cell is a HEAD-AND-SHOULDERS close-up of the SAME PERSON — the head, neck, and the top of the shoulders wearing the costume; a little of the shoulders and collar showing is good, no bare skin below the neck. Never crop the top of the head. Cell 1 front, cell 2 three-quarter, cell 3 profile, cell 4 back of head. Photographic / lifelike; identity from Image 2; hair, skin tone, and costume consistent with Image 3. No text, numbers, labels, arrows, or symbols.`;
}

// Composite the head row (top) over the body row (bottom) into one 2×4 sheet,
// with a thin black seam so the row splitter (detectSheetRowDivider) locks onto
// the boundary. Widths are matched to the body row; heights stay native.
// Returns { imageData, splitY } — splitY is where the head/body divider sits.
async function stackRowsInto2x4(headRowData, bodyRowData) {
  const headBuf = Buffer.from(r2.stripDataUriPrefix(headRowData), 'base64');
  const bodyBuf = Buffer.from(r2.stripDataUriPrefix(bodyRowData), 'base64');
  const bMeta = await sharp(bodyBuf).metadata();
  const W = bMeta.width;
  const headResized = await sharp(headBuf).resize({ width: W }).toBuffer();
  const hMeta = await sharp(headResized).metadata();
  const SEAM = 12;
  // Full-width stack, NO side padding: head row generated at 20:9 (576 tall) +
  // body row at 16:9 (720 tall) ≈ 1280×1300 ≈ 1:1, a native preset. Pass-2 style
  // transfer runs at the nearest preset (aspectPresetFor → 1:1, ~1% off = no
  // visible squeeze), columns stay at W/4 (no margins). The head/body boundary
  // is a SOLID WHITE gutter — a clean uniform (zero-variance) band the shared
  // splitter locks onto, matching the sheet's white background (owner request).
  const H = hMeta.height + SEAM + bMeta.height;
  const splitY = hMeta.height + Math.round(SEAM / 2);
  const out = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([
      { input: headResized, top: 0, left: 0 },
      { input: bodyBuf, top: hMeta.height + SEAM, left: 0 },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
  return { imageData: `data:image/jpeg;base64,${out.toString('base64')}`, splitY };
}

// SINGLE source of truth for the body-row head axis. Pose (geometry) owns "is
// there a head"; Gemini owns feet/outfit/proportions/background. Mutates
// `bodies` in place: sets fullBody.fullBodyScore = min(pose-head, gemini-feet),
// recomputes bodies.finalScore/valid, and stamps headSource. poseHeads === null
// → fall back to Gemini's headScore, loudly. Used by BOTH evaluateSheetSplit
// (whole-sheet eval / Test Lab) and generateComposited2x4 (per-row review).
function applyPoseHeadGate(bodies, poseHeads) {
  const fb = bodies?.fullBody;
  if (!fb) return bodies;
  const gemFeet = fb.feetScore ?? fb.fullBodyScore ?? 10;
  const gemHead = fb.headScore ?? fb.fullBodyScore ?? 10;
  let headScoreEff, headReason;
  if (poseHeads && Array.isArray(poseHeads.cells)) {
    fb.headSource = 'pose';
    fb.poseCells = poseHeads.cells.map(c => ({ head: c.head, head_max: c.head_max, clipped: c.clipped }));
    const missing = poseHeads.cells.map((c, i) => ({ c, i })).filter(({ c }) => !c.head || c.clipped);
    headScoreEff = missing.length ? 1 : 10;
    headReason = missing.length
      ? `pose head-check: ${missing.length}/4 body cells have no head (${missing.map(({ i }) => `cell${i + 1}`).join(', ')})`
      : 'pose head-check: all 4 body cells have a head';
  } else {
    fb.headSource = 'gemini-fallback';
    headScoreEff = gemHead;
    headReason = `pose UNAVAILABLE — head axis fell back to Gemini (headScore=${gemHead}, unreliable on headless torsos)`;
    log.error(`[CHARACTER 2×4] pose /pose-heads unavailable — body-row head check FELL BACK to Gemini (headScore=${gemHead}). Fix the analyzer; Gemini hallucinates heads on headless bodies.`);
  }
  fb.fullBodyScore = Math.min(headScoreEff, gemFeet);
  fb.reason = `${headReason}; feet=${gemFeet}`;
  // This recompute — not the model's own finalScore — is what the gate reads, so
  // every sub-score the bodies template emits must appear here or it is scored
  // and then silently dropped. costumeReads defaults to 10 for the standard
  // (uncostumed) case, where the template is told to return 10.
  bodies.finalScore = Math.min(
    fb.fullBodyScore,
    bodies.angles?.score ?? 10,
    bodies.outfit?.outfitScore ?? 10,
    bodies.costumeReads?.costumeReadsScore ?? 10,
    bodies.proportions?.score ?? 10,
    bodies.background?.backgroundScore ?? 10,
  );
  bodies.valid = bodies.finalScore >= 6;
  if (fb.fullBodyScore <= 2) bodies.failureReasons = [...(bodies.failureReasons || []), `fullBody: ${headReason}`];
  return bodies;
}

// Review the 1×4 body row on its own (it IS the bottom-body crop the eval wants,
// so no split needed): pose head-check + Gemini bodies eval, merged by the gate.
async function reviewBodyRow(bodyRowData, { costumeDescription, costumeName = null, model, usageTracker }) {
  const [poseHeads, bodiesR] = await Promise.all([
    detectBodyRowHeads(bodyRowData),
    evaluateSheetRow(bodyRowData, 'bodies', { costumeDescription, costumeName, model, usageTracker }),
  ]);
  const bodies = applyPoseHeadGate(bodiesR.report, poseHeads);
  return { valid: !!bodies.valid, score: bodies.finalScore ?? 0, bodies, promptUsed: bodiesR.promptUsed };
}

// Review the 1×4 head row: heads-structure eval + identity vs face photo/avatar.
async function reviewHeadRow(headRowData, { facePhoto, avatarFaces, model, usageTracker }) {
  const hasRefs = !!(facePhoto || avatarFaces);
  const [headsR, identityR] = await Promise.all([
    evaluateSheetRow(headRowData, 'heads', { model, usageTracker }),
    hasRefs ? evaluateIdentity(headRowData, { sourcePhoto: facePhoto, avatarFaces, model, usageTracker }) : Promise.resolve(null),
  ]);
  const heads = headsR.report;
  const identity = identityR?.report || null;
  const idScore = identity?.identityScore ?? 10;
  const score = Math.min(heads?.finalScore ?? 0, idScore);
  return { valid: score >= 6, score, heads, identity, promptUsed: headsR.promptUsed };
}

// Two-call generation → one composited 2×4 sheet, WITH review between the calls.
// (1) body row, reviewed (pose + bodies eval); max 1 retry, keep least-bad.
// (2) head row on the ACCEPTED body, reviewed (heads + identity); max 1 retry,
// keep least-bad. Then composite. Rejected rows are discarded. Returns a verdict
// in the evaluateSheetSplit shape so generateCharacter2x4Sheet / styledAvatars
// consume it unchanged. skipReview → 1 try each, no eval (fast path for tests).
async function generateComposited2x4(character, { costumeDescription, costumeName = null, redress = false, usageTracker = null, skipReview = false } = {}) {
  const facePhoto = await resolveFacePhoto(character);
  if (!facePhoto) throw new Error(`No face photo for ${character?.name || 'character'}.`);
  const standardAvatar = await resolveStandardAvatar(character);
  const avatarFaces = standardAvatar ? (await splitSheetRows(standardAvatar)).topHeads : null;
  const bodyPhantom = await phantomRow(loadPhantomVariant(character?.age, 'plain'), 'bottom');
  const headPhantom = await phantomRow(loadPhantomVariant(character?.age, 'axes'), 'top');
  const model = MODEL_DEFAULTS.sheetEvalModel;
  const bodyRefs = standardAvatar ? [bodyPhantom, standardAvatar, facePhoto] : [bodyPhantom, facePhoto];
  const bodyPrompt = buildBodyRowPrompt(costumeDescription, character, redress, costumeName);
  const headPrompt = buildHeadRowPrompt(character);
  const attemptHistory = [];
  let usage = { input_tokens: 0, output_tokens: 0 };
  const addUsage = (u, fn, id) => { if (u) { usage.input_tokens += u.input_tokens || 0; usage.output_tokens += u.output_tokens || 0; if (usageTracker) usageTracker('grok', u, fn, id); } };

  // ── Stage 1: body row (max 1 retry, keep least-bad) ──
  let bestBody = null;
  for (let t = 1; t <= 2; t++) {
    const res = await editWithGrok(bodyPrompt, bodyRefs, { aspectRatio: '16:9', model: GROK_MODELS.STANDARD });
    if (!res?.imageData) { attemptHistory.push({ stage: 'body', try: t, error: 'no image' }); continue; }
    addUsage(res.usage, 'character_2x4_body_row', res.modelId);
    let review = { valid: true, score: 10, bodies: null };
    if (!skipReview) {
      try {
        review = await reviewBodyRow(res.imageData, { costumeDescription, costumeName, model, usageTracker });
      } catch (err) {
        // Keep the sheet. Losing the eval costs a quality gate; losing the
        // sheet costs the character its face on every page of the book, which
        // is strictly worse. Loud, and visible in attemptHistory.
        log.error(`[CHARACTER 2×4] ${character?.name} body eval FAILED (${err.message}) — keeping the unscored sheet`);
        review = { valid: true, score: 0, bodies: null, evalFailed: err.message };
      }
    }
    attemptHistory.push({ stage: 'body', try: t, score: review.score, valid: review.valid, reasons: review.bodies?.failureReasons || [] });
    if (!bestBody || review.score > bestBody.review.score) bestBody = { row: res.imageData, review };
    if (review.valid) break;
    log.warn(`[CHARACTER 2×4] ${character?.name} body try ${t} invalid (score=${review.score}) — ${skipReview ? '' : (review.bodies?.failureReasons || []).join('; ')}`);
  }
  if (!bestBody) throw new Error(`[CHARACTER 2×4] body row produced no image for ${character?.name}`);

  // ── Stage 2: head row on the accepted body (max 1 retry, keep least-bad) ──
  // Head row uses 20:9 — the widest/shortest ratio in Grok's aspect enum
  // (16:3 is not allowed). Stacked under the 16:9 body row the composite is
  // ~1:1 (720 + 576 ≈ 1280 tall), a native preset for the Pass-2 style call, so
  // no padding/squeeze; full-width, no side margins. See stackRowsInto2x4.
  const headRefs = [headPhantom, facePhoto, bestBody.row]; // exactly 3
  let bestHead = null;
  for (let t = 1; t <= 2; t++) {
    const res = await editWithGrok(headPrompt, headRefs, { aspectRatio: '20:9', model: GROK_MODELS.STANDARD });
    if (!res?.imageData) { attemptHistory.push({ stage: 'head', try: t, error: 'no image' }); continue; }
    addUsage(res.usage, 'character_2x4_head_row', res.modelId);
    let review = { valid: true, score: 10, heads: null, identity: null };
    if (!skipReview) {
      try {
        review = await reviewHeadRow(res.imageData, { facePhoto, avatarFaces, model, usageTracker });
      } catch (err) {
        log.error(`[CHARACTER 2×4] ${character?.name} head eval FAILED (${err.message}) — keeping the unscored row`);
        review = { valid: true, score: 0, heads: null, identity: null, evalFailed: err.message };
      }
    }
    attemptHistory.push({ stage: 'head', try: t, score: review.score, valid: review.valid });
    if (!bestHead || review.score > bestHead.review.score) bestHead = { row: res.imageData, review };
    if (review.valid) break;
    log.warn(`[CHARACTER 2×4] ${character?.name} head try ${t} invalid (score=${review.score})`);
  }
  if (!bestHead) throw new Error(`[CHARACTER 2×4] head row produced no image for ${character?.name}`);

  // ── Composite + build the evaluateSheetSplit-shape verdict from the reviews ──
  const { imageData, splitY } = await stackRowsInto2x4(bestHead.row, bestBody.row);
  const bodies = bestBody.review.bodies;
  const heads = bestHead.review.heads;
  const identity = bestHead.review.identity;
  const idScore = identity?.identityScore ?? 10;
  const finalScore = skipReview ? 10 : Math.min(heads?.finalScore ?? 0, bodies?.finalScore ?? 0, idScore);
  // When a row judge threw, its sub-report is null and the ?? defaults below
  // read as a perfect 10. Carry the failure so consumers show "unscored", not
  // a fake pass — the sheet still ships, it just wasn't judged.
  const evalFailed = bestBody.review.evalFailed || bestHead.review.evalFailed || null;
  const verdict = {
    split: true, splitY, finalScore, valid: finalScore >= 6, evalFailed,
    failureReasons: [...(heads?.failureReasons || []), ...(bodies?.failureReasons || [])],
    layout: { layoutScore: bodies?.fullBody?.fullBodyScore ?? 10 },
    identity: { identityScore: idScore, reason: identity?.reason },
    outfit: { outfitScore: bodies?.outfit?.outfitScore ?? 10 },
    sourceMatch: { sourceMatchScore: idScore },
    cleanRender: { cleanScore: heads?.cleanRender?.cleanScore ?? 10 },
    heads, bodies, identityReport: identity,
  };
  return {
    imageData, verdict, usage, modelId: GROK_MODELS.STANDARD,
    refs: { phantom: headPhantom, bodyPhantom, standardAvatar, facePhoto },
    prompt: `— BODY ROW —\n${bodyPrompt}\n\n— HEAD ROW —\n${headPrompt}`,
    bodyRow: bestBody.row, headRow: bestHead.row, attemptHistory,
  };
}

function buildPrompt(_artStyle, costumeDescription, character = null, redress = false, costumeName = null) {
  const hairBlock = buildHairBlock(character);
  // redress=true: the story dressed this character in an outfit that DIFFERS
  // from the clothing shown in Image 2 (the stored avatar). Image 2's clothing
  // is OLD and must be ignored — the Costume text below is the single source of
  // truth for the outfit. Without this, the model splits the difference (old
  // clothing on the body cells, new clothing on the head cells) and the scene,
  // which reads the body cell, renders the wrong outfit → eval desync → redos.
  const bodyRef = redress
    ? `Image 2 shows the character's body shape, build, and identity ONLY — IGNORE the clothing in Image 2, it is the wrong outfit. Image 3 is the character's face.`
    : `Image 2 is the character's body. Image 3 is the character's face.`;
  const named = costumeName ? ` — a ${costumeName}` : '';
  const outfitRule = redress
    ? `Costume${named} (the ONLY outfit — every body cell wears exactly this, NOT the clothing from Image 2): ${costumeDescription}`
    : `Costume${named}: ${costumeDescription}`;
  return `Image 1 indicates only the camera angle and facing direction in each cell — ignore its silhouette, body, and face. The coloured arrows (red, green, blue) on each head in Image 1 are direction guides ONLY — never render, copy, or paint them onto the character, the face, the hair, or anywhere in the output. The output contains no arrows.
${bodyRef}

${outfitRule}
${hairBlock}
Render every cell as a REALISTIC reference — the same visual style as the source face photo in Image 3. Photographic / lifelike, with natural proportions matching the person's apparent age in Image 3. No cartoon stylisation, no chibi, no anime, no watercolour — those treatments are applied later by downstream steps. This sheet is an identity anchor.

Output a 2×4 grid with thin black dividing lines and pure white background, in the same cell layout as Image 1.

The horizontal mid-row divider must be drawn as one unbroken thin black line running edge to edge. The three vertical column dividers must be drawn the same way. Nothing crosses any divider: every figure stays fully inside its own cell, surrounded by white space on all four sides. No head, no hair, no hand, no foot, no shadow, no clothing detail extends beyond the cell's borders. If a figure would not fit inside its cell, scale it down so it fits.

Cells 1-4 (top row): head and neck only, no shoulders, no torso, no clothing. Cell 1 front, cell 2 three-quarter, cell 3 profile, cell 4 back of head. The head occupies roughly the middle of the cell with white margin above the hairline and below the neck — the neck stops cleanly, it never continues into the bottom row.
Cells 5-8 (bottom row): full body from head to feet wearing the costume. Cell 5 front, cell 6 three-quarter, cell 7 profile, cell 8 back. The full figure fits entirely between the mid-row divider and the bottom edge — the head of a bottom-row body never extends up into the top row, and both feet with their shoes are fully visible with a strip of white margin below the shoes. Never crop a bottom-row figure at the thigh, knee, or ankle; if it does not fit, scale the whole figure down until head and both feet sit inside the cell. Body proportions must match the person's apparent age in Image 3: an adult is roughly 7 to 8 heads tall, a teenager about 7, a young child about 5 to 6, a toddler about 4. Do NOT render an adult with child-like short/stubby proportions or an oversized head on a small body — the full-body figures must read as the same age as the head cells.

Every cell faces in the same direction as the matching cell in Image 1. Every head in cells 1-4 and every body in cells 5-8 shows THE SAME PERSON as Image 3 — same face structure, same hair, same skin tone, same apparent age. The same costume — every accessory — appears in cells 5, 6, 7, and 8. No text, no numbers, no labels, no arrows, no symbols, no coloured direction markers anywhere in the output.`;
}

/**
 * Resolve the character's face photo to a base64 data URI (the shape
 * editWithGrok requires). Uses the canonical getFacePhoto helper to pick the
 * right field, then bytesFromAnyImage to fetch URLs / decode base64 / etc. —
 * the same path every other consumer in the codebase uses.
 *
 * Async because R2 URLs require an HTTP fetch. Previously this function was
 * sync and only accepted data URIs / >1000-char base64 strings, which silently
 * dropped post-R2-migration HTTPS URLs (~80 chars) and threw "No face photo".
 */
async function resolveFacePhoto(character) {
  if (!character) return null;
  // getFacePhoto is the single source of truth for the face-photo lookup
  // (handles both photos.face / photos.original and the legacy top-level
  // thumbnail_url / facePhoto / photo_url fallbacks). Could be a URL, data
  // URI, or raw base64 — bytesFromAnyImage decodes any of them.
  const candidate = getFacePhoto(character);
  if (!candidate) return null;
  const bytes = await r2.bytesFromAnyImage(candidate);
  if (!bytes) return null;
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

/**
 * Resolve the character's base standard avatar to a data URI. Returns null
 * when missing — caller falls back to face-photo-only. Same URL-fetch
 * handling as resolveFacePhoto above.
 *
 * Dual-shape (Phase 1 migration): getStandardAvatar reads NEW
 * `avatars.standard` (URL string) first, falls back to OLD `avatars.standardUrl`
 * or the legacy { imageUrl, imageData } object form. One helper, one source
 * of truth — no inline string/object branches needed here.
 */
async function resolveStandardAvatar(character) {
  if (!character?.avatars) return null;
  const candidate = getStandardAvatar(character, 'standard');
  if (!candidate) return null;
  const bytes = await r2.bytesFromAnyImage(candidate);
  if (!bytes) return null;
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

/**
 * Cheap pixel-level layout check — runs before the Gemini call. The intent
 * is: every gutter band should be a UNIFORM solid colour (no figure
 * crossing it). The actual colour doesn't matter — white, gray, beige,
 * pale blue all fine — what matters is that the band reads as one flat
 * tone, not a streak of mixed skin / clothing / hair pixels.
 *
 * Previous versions of this check required ≥80%, then ≥60% of pixels to
 * be specifically WHITE (lum > 240). That rejected sheets with a cream
 * or light-gray background as if a figure were crossing, even when the
 * gutter was perfectly clean. Real-world failures on staging story
 * job_1779388105801: Emma + Sarah pass-1 attempts each scored 0 three
 * times despite producing perfectly fine sheets — because the figures'
 * clothing tone bled into the band's average and pulled the "% white
 * pixels" below threshold.
 *
 * New rule: in each band, measure how many pixels are close to the
 * band's median colour. If ≥60% of pixels in the band are within a
 * small RGB distance of the band's median, the band is uniform (whatever
 * its tone) and we pass it. A figure crossing the band mixes 2+ distinct
 * tones (skin + clothing + hair vs background) and dramatically lowers
 * the "close-to-median" fraction.
 *
 * Returns { valid, reason } — valid=true when every gutter band is ≥60%
 * uniform.
 */
async function quickLayoutCheck(imageData) {
  const b64 = r2.stripDataUriPrefix(imageData);
  const buf = Buffer.from(b64, 'base64');
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const band = Math.max(2, Math.round(Math.min(W, H) * 0.015));

  // Per-channel distance from median that still counts as "same tone".
  // 25 is roughly the tolerance for paper noise / wash gradients without
  // accommodating skin (~+50 from a pale bg) or clothing (~+80+).
  const TOL = 25;

  // Returns the fraction of pixels in `samples` (an array of [r,g,b])
  // that lie within TOL of the per-channel median.
  function uniformFraction(samples) {
    if (samples.length === 0) return 0;
    const rs = samples.map(p => p[0]).sort((a, b) => a - b);
    const gs = samples.map(p => p[1]).sort((a, b) => a - b);
    const bs = samples.map(p => p[2]).sort((a, b) => a - b);
    const mid = Math.floor(rs.length / 2);
    const mR = rs[mid], mG = gs[mid], mB = bs[mid];
    let close = 0;
    for (const [r, g, b] of samples) {
      if (Math.abs(r - mR) <= TOL && Math.abs(g - mG) <= TOL && Math.abs(b - mB) <= TOL) close++;
    }
    return close / samples.length;
  }

  function rowBand(yCenter) {
    const samples = [];
    for (let y = yCenter - band; y <= yCenter + band; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        samples.push([data[i], data[i+1], data[i+2]]);
      }
    }
    return uniformFraction(samples);
  }
  function colBand(xCenter) {
    const samples = [];
    for (let x = xCenter - band; x <= xCenter + band; x++) {
      if (x < 0 || x >= W) continue;
      for (let y = 0; y < H; y++) {
        const i = (y * W + x) * 3;
        samples.push([data[i], data[i+1], data[i+2]]);
      }
    }
    return uniformFraction(samples);
  }
  const checks = [
    { name: 'mid-row gutter',  uniformFrac: rowBand(Math.floor(H / 2)) },
    { name: 'col gutter 1/4',  uniformFrac: colBand(Math.floor(W / 4)) },
    { name: 'col gutter 2/4',  uniformFrac: colBand(Math.floor(W / 2)) },
    { name: 'col gutter 3/4',  uniformFrac: colBand(Math.floor(3 * W / 4)) },
  ];
  const THRESHOLD = 0.60;
  for (const c of checks) {
    if (c.uniformFrac < THRESHOLD) {
      return { valid: false, reason: `${c.name} only ${(100*c.uniformFrac).toFixed(1)}% uniform (need ≥${Math.round(THRESHOLD*100)}%) — figure likely crosses the gutter` };
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
/**
 * Build a concise text profile of the character for the eval prompt's
 * CHARACTER_PROFILE block. Lets Gemini cross-check apparent age, gender,
 * hair, etc. — without it the eval has no way to flag "looks like Roger
 * but rendered as a 10-year-old". Returns "" when no profile data exists
 * (the prompt then drops the block).
 */
function buildCharacterDescription(character) {
  if (!character) return '';
  const parts = [];
  if (character.name) parts.push(`Name: ${character.name}`);
  if (character.age) parts.push(`Age: ${character.age} years old`);
  if (character.ageCategory) parts.push(`Age category: ${character.ageCategory}`);
  if (character.gender) parts.push(`Gender: ${character.gender}`);
  if (character.height) parts.push(`Height: ${character.height} cm`);
  if (character.build) parts.push(`Build: ${character.build}`);
  const phys = character.physical || {};
  if (phys.hairColor || phys.hairLength || phys.hairStyle) {
    const hair = [phys.hairColor, phys.hairLength, phys.hairStyle].filter(Boolean).join(', ');
    if (hair) parts.push(`Hair: ${hair}`);
  }
  if (phys.facialHair) parts.push(`Facial hair: ${phys.facialHair}`);
  if (phys.glasses) parts.push(`Glasses: ${phys.glasses}`);
  if (phys.distinctiveMarks) parts.push(`Distinctive marks: ${phys.distinctiveMarks}`);
  return parts.join('\n');
}

const SHEET_JUDGE_SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

// Vision-judge dispatcher for the sheet evaluators. `model` is a TEXT_MODELS
// key (e.g. 'gemini-2.5-flash', 'grok-4-fast', 'qwen3-vl') or a bare Gemini
// modelId (defaults to google). Production passes nothing → gemini-2.5-flash,
// so the google branch stays byte-identical to the old inline fetch. Grok/Qwen
// reuse the SAME `parts` array (images + prompt) via the existing vision
// helpers. Returns { text, usageMetadata }.
async function callSheetJudge(model, parts, maxOutputTokens, geminiApiKey) {
  const { TEXT_MODELS } = require('../config/models');
  const cfg = TEXT_MODELS[model];
  const provider = cfg?.provider || 'google';
  const modelId = cfg?.modelId || model;
  if (provider === 'google') {
    const body = {
      contents: [{ parts }],
      // thinkingBudget: 0 — these are structured scoring judges at temp 0, not
      // open reasoning. Thinking tokens counted against maxOutputTokens and
      // truncated the JSON; disabling them removes that failure mode at the
      // source (and is faster/cheaper). maxOutputTokens stays high as headroom.
      generationConfig: { temperature: 0, maxOutputTokens, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
      safetySettings: SHEET_JUDGE_SAFETY,
    };
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${geminiApiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }
    );
    if (!resp.ok) throw new Error(`Gemini eval HTTP ${resp.status}`);
    const j = await resp.json();
    const cand = j?.candidates?.[0];
    // gemini-2.5 thinking tokens count toward maxOutputTokens; when the budget
    // runs out the JSON is cut off mid-string and parseJudgeJson chokes with a
    // cryptic "Expected ',' or '}' at position N". Name the real cause instead —
    // the retry loop then re-runs, and the caller's fail-open keeps the sheet.
    if (cand?.finishReason === 'MAX_TOKENS') {
      throw new Error(`Gemini eval truncated (finishReason=MAX_TOKENS at ${maxOutputTokens}-tok cap) — raise maxOutputTokens`);
    }
    return { text: cand?.content?.parts?.[0]?.text, usageMetadata: j?.usageMetadata };
  }
  if (provider === 'xai') {
    const { callGrokVisionAPI } = require('./images');
    const resp = await callGrokVisionAPI(model, modelId, parts, '');
    if (!resp?.ok) throw new Error(`Grok vision eval failed (${model})`);
    const j = await resp.json();
    return { text: j?.candidates?.[0]?.content?.parts?.[0]?.text, usageMetadata: j?.usageMetadata };
  }
  if (provider === 'openrouter') {
    const { callOpenRouterVisionAPI } = require('./evalJudges');
    const text = await callOpenRouterVisionAPI(modelId, parts);
    if (!text) throw new Error(`OpenRouter vision eval returned nothing (${model})`);
    return { text, usageMetadata: null };
  }
  throw new Error(`"${model}" (provider ${provider}) is not a supported vision judge`);
}

// Non-Gemini judges don't honor responseMimeType:json, so their text may be
// fenced or prose-wrapped. Try strict parse, then ```json``` fence, then the
// first {…last } span.
function parseJudgeJson(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ } }
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const body = s.slice(first, last + 1);
    try { return JSON.parse(body); } catch { /* fall through to repair */ }
    // Repair only what is unambiguous: a trailing comma before } or ]. Reached
    // ONLY after a real parse failure, so it can help and cannot hurt. Anything
    // cleverer (stripping // comments) risks mangling a string that merely
    // contains "//" — and the caller now survives a parse failure anyway.
    const repaired = body.replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(repaired); } catch (err) {
      // Include the payload. The previous version threw JSON.parse's own
      // message ("Expected ',' or '}' at position 310"), which says nothing
      // about WHAT the judge wrote — three avatars were lost to that blind spot.
      throw new Error(`judge returned unparseable JSON (${err.message}): ${body.slice(0, 400)}`);
    }
  }
  throw new Error(`judge returned non-JSON: ${s.slice(0, 400)}`);
}

async function evaluateSheetWithGemini(imageData, costumeDescription, geminiApiKey, sourcePhoto = null, usageTracker = null, opts = {}) {
  // model / promptOverride let the Test Lab A/B eval models and prompt text
  // without touching production (which passes neither → defaults below).
  const { standardAvatar = null, characterDescription = '', model = 'gemini-2.5-flash', promptOverride = null } = opts;
  const sheetB64 = r2.stripDataUriPrefix(imageData);
  const sheetMime = imageData.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  let prompt = promptOverride || PROMPT_TEMPLATES.sheet2x4Evaluation;
  if (!prompt) throw new Error('sheet2x4Evaluation prompt template not loaded');
  // Braced placeholders via fillTemplate ($-safe, global, strips unfilled).
  // The old bare-word .replace(/REQUESTED_OUTFIT/g, ...) also rewrote the
  // PROSE references to the placeholder name ("Read REQUESTED_OUTFIT
  // below...") — those references stay bare words in the template and are
  // untouched now.
  prompt = fillTemplate(prompt, {
    REQUESTED_OUTFIT: costumeDescription ? `REQUESTED_OUTFIT: ${costumeDescription}` : '',
    CHARACTER_PROFILE_BLOCK: (characterDescription && characterDescription.trim())
      ? `CHARACTER PROFILE (declared spec for this person — authoritative on age, gender, build):\n${characterDescription.trim()}\n`
      : '',
  });

  // Image order matters — prompt labels Image 1 = source face, Image 2 =
  // standard avatar (when supplied), Image LAST = generated sheet. The eval
  // text adapts to "Image 2" vs "Image 3" semantics for the sheet via the
  // "Image LAST" phrasing in the prompt. When no sourcePhoto provided, falls
  // back to sheet-only (Task 4 still attempts but has no baseline; Task 2
  // falls back to cell-1-as-anchor mode documented in the prompt).
  const parts = [];
  if (sourcePhoto) {
    const srcB64 = r2.stripDataUriPrefix(sourcePhoto);
    const srcMime = sourcePhoto.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    parts.push({ inline_data: { mime_type: srcMime, data: srcB64 } });
  }
  if (standardAvatar) {
    const avB64 = r2.stripDataUriPrefix(standardAvatar);
    const avMime = standardAvatar.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    parts.push({ inline_data: { mime_type: avMime, data: avB64 } });
  }
  parts.push({ inline_data: { mime_type: sheetMime, data: sheetB64 } });
  parts.push({ text: prompt });

  const { text, usageMetadata } = await callSheetJudge(model, parts, 4000, geminiApiKey);
  if (!text) throw new Error(`sheet eval (${model}) returned no text`);
  if (usageTracker && usageMetadata) {
    usageTracker('gemini_quality', {
      input_tokens: usageMetadata.promptTokenCount || 0,
      output_tokens: usageMetadata.candidatesTokenCount || 0,
    }, 'character_2x4_eval', model);
  }
  return parseJudgeJson(text);
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
  const { resolveArtStyleForSheet } = require('./storyHelpers');
  // Sheet-safe style line: environment/scene clauses stripped so the model
  // does not paint a background behind the reference figures (see
  // resolveArtStyleForSheet). Keeps rendering technique, palette, and faces.
  const style = resolveArtStyleForSheet(artStyle, 'grok');
  if (style) return style;
  // Unknown style id (shouldn't happen — frontend constrains to ART_STYLES).
  // Fail loudly instead of silently swapping to watercolour.
  throw new Error(`[CHARACTER 2×4] Unknown artStyle "${artStyle}" — add it to ART_STYLES in server/lib/storyHelpers.js`);
}

// Clean, non-redundant style-transfer prompt (2026-08-09): task first, the style
// descriptor mentioned ONCE, an optional Image-2 style anchor, and a single
// content-preservation line. Replaces the old version that inlined the whole
// descriptor 3× with a long preserve-list — A/B showed the wording doesn't move
// Grok's stylisation ceiling, but the tidy prompt holds the style without the
// realism backfire the over-constrained variant caused. `hasAnchor` adds the
// "Image 2 is the style reference" line only when styleTransferGenerate passes one.
function buildStyleTransferPrompt(artStyle, { hasAnchor = false } = {}) {
  const styleLine = resolveStyleLineForSheet(artStyle);
  // Image 2's PEOPLE keep bleeding into the sheet (job_1786277779744 2026-08-09;
  // again job_1786484554633 2026-08-12 — the anchor family ghosted across Noah's
  // cells despite the "unrelated people, don't copy" wording). Second-generation
  // wording: never mention that Image 2 contains people at all — call it a
  // swatch, and state the single-subject rule as a property of the OUTPUT
  // ("alone in every cell") rather than a negation about Image 2.
  const anchorLine = hasAnchor
    ? '\nImage 2 is a swatch of the painting technique, palette, and paper texture only. Take nothing else from it: no figure, face, garment, or composition — every painted element in the output comes from Image 1.'
    : '';
  return `Change the art style of Image 1 — a 2×4 character reference sheet (8 cells) — to: ${styleLine}
Render all 8 cells uniformly in this style — no cell left photographic.

Keep the content of Image 1 unchanged; only the art style changes. Every cell shows the same single character as Image 1, alone — no other person or figure anywhere on the sheet.${anchorLine}`;
}

// Optional per-art-style STYLE ANCHOR asset (server/assets/style-anchor-<style>.jpg|png)
// — a strong, character-free reference painting of that medium (e.g. a watercolour
// family group). Passed as Image 2 in styleTransferGenerate; the prompt then names
// it. Returns a data URI, or null if no asset exists (graceful → no anchor).
function loadStyleAnchor(artStyle) {
  if (!artStyle) return null;
  const id = String(artStyle).toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const ext of ['jpg', 'png']) {
    const file = path.join(ASSETS_DIR, `style-anchor-${id}.${ext}`);
    if (fs.existsSync(file)) {
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
      return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
    }
  }
  return null;
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
async function evaluateStyledSheetWithGemini(sourcePhoto, realisticSheet, styledSheet, artStyle, geminiApiKey, usageTracker = null, declaredAge = null, opts = {}) {
  // model / promptOverride: Test Lab A/B only; production passes neither.
  const { model = 'gemini-2.5-flash', promptOverride = null } = opts;
  const styleLabel = resolveStyleLineForSheet(artStyle);

  let prompt = promptOverride || PROMPT_TEMPLATES.sheet2x4StyleEval;
  if (!prompt) throw new Error('sheet2x4StyleEval prompt template not loaded');
  prompt = prompt.replace(/REQUESTED_STYLE/g, `REQUESTED_STYLE: ${styleLabel}`);
  // TASK 7 age gate — style transfer is where kids drift younger (the art
  // style's cute prior). Unknown age disables the task (prompt scores it 10).
  const ageNum = parseInt(declaredAge, 10);
  prompt = prompt.replace(/CHARACTER_AGE/g, Number.isFinite(ageNum) ? `${ageNum} years old` : 'unknown');

  const toInlinePart = (dataUri) => {
    const b64 = r2.stripDataUriPrefix(dataUri);
    const mime = dataUri.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    return { inline_data: { mime_type: mime, data: b64 } };
  };

  // 8000 not 2500: gemini-2.5 internal thinking counts toward maxOutputTokens —
  // the TASK-5 colour enumeration makes it think longer, and a 2500 cap
  // truncated the JSON mid-string (parse failures).
  const parts = [
    toInlinePart(sourcePhoto),
    toInlinePart(realisticSheet),
    toInlinePart(styledSheet),
    { text: prompt },
  ];
  // Degenerate-judge guard: the model sometimes returns the prompt's example
  // JSON verbatim instead of judging (Noah, job_1786484554633 — a sheet full of
  // ghost anchor-figures shipped with all-9s whose outfit reason was the
  // example's "Navy shirt + tan pants"). The template's example now uses
  // <placeholder> reasons, so an echoed verdict is detectable; re-ask once,
  // then fail the eval so the retry loop treats the attempt as unjudged.
  for (let evalTry = 1; evalTry <= 2; evalTry++) {
    const { text, usageMetadata } = await callSheetJudge(model, parts, 8000, geminiApiKey);
    if (!text) throw new Error(`style-eval (${model}) returned no text`);
    if (usageTracker && usageMetadata) {
      usageTracker('gemini_quality', {
        input_tokens: usageMetadata.promptTokenCount || 0,
        output_tokens: usageMetadata.candidatesTokenCount || 0,
      }, 'character_2x4_style_eval', model);
    }
    const verdict = parseJudgeJson(text);
    if (!isEchoedStyleVerdict(verdict)) return verdict;
    log.warn(`[CHARACTER 2×4] style-eval returned the template example verbatim (try ${evalTry}/2) — ${evalTry < 2 ? 're-asking' : 'failing the eval'}`);
  }
  throw new Error('style-eval echoed the template example twice — degenerate judge response');
}

// A verdict whose reasons are the template's own example/placeholder strings was
// never judged. Two signatures: an unfilled "<placeholder>" (current template)
// or the pre-2026-08-12 worked example's distinctive reason strings.
const LEGACY_EXAMPLE_REASONS = [
  'Navy shirt + tan pants + brown loafers preserved across cells 5-8',
  'Same 4×2 grid as Image 2, no figure crosses gutters',
  'Only the target character appears; no other or extra people in any cell',
];
function isEchoedStyleVerdict(verdict) {
  const reasons = ['layout', 'identity', 'style', 'outfit', 'clean', 'bodyFace', 'age', 'solo']
    .map(k => verdict?.[k]?.reason)
    .filter(r => typeof r === 'string');
  if (reasons.length === 0) return false;
  return reasons.some(r => r.includes('<') || LEGACY_EXAMPLE_REASONS.some(ex => r.trim() === ex));
}

// Split a 2×4 sheet into its top (4 heads) and bottom (4 bodies) rows. The head
// row and body row are NOT equal height, so the divider is NOT at H/2. We locate
// the actual divider line with the SAME production detector used to split avatar
// grids (grok.detectMinVarianceSeparator): the divider — a thin black/white line
// — is near-uniform, so it sits at the minimum-variance row within 0.25–0.75 H.
// ONE splitter for the whole app. The head/body row divider is found by the
// SAME robust line-detector the story uses to crop avatar cells — the Python
// /split-reference-sheet endpoint (_detect_separators: the near-uniform-colour
// row is the gutter). NEVER a blind 50% cut: a 2×4 sheet's rows are not equal
// (head-shots are shorter than full bodies), and a fixed cut sliced the bodies'
// heads off (Daniel, 2026-08-08). Falls back to the JS variance separator only
// if the analyzer is unreachable, so an eval never hard-fails on a cold service.
// Head-presence per cell of the bottom (body) row — the ONLY source of truth for
// "does each full body have a head". A Gemini VLM hallucinates the head on a
// headless torso (head+body co-occur in training — POPE-adversarial object
// hallucination, docs/research-log.html), so the head axis is judged by geometry
// instead: the Python /pose-heads endpoint runs YOLO pose and reports whether a
// head keypoint (nose/eyes/ears) fires above the shoulders in each cell. Validated
// on set #2 (exp #419): headed cells 0.86–1.00, headless 0.00–0.10, no overlap.
// `clipped` = a head found only at the very top edge (a head-shot chin bleeding in
// past the gutter, or a body clipped by the divider) — treated as no-head. Returns
// null if the analyzer is unreachable so the eval degrades to Gemini-only rather
// than hard-failing on a cold service.
async function detectBodyRowHeads(bottomBodyImageData) {
  try {
    const url = (process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000') + '/pose-heads';
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: bottomBodyImageData, cols: 4 }),
      signal: AbortSignal.timeout(60_000),
    });
    if (r.ok) {
      const j = await r.json();
      if (j?.success && Array.isArray(j.cells)) return j;
    }
    log.warn('[CHARACTER 2×4] /pose-heads gave no result — bodies head-check falls back to Gemini');
  } catch (err) {
    log.warn(`[CHARACTER 2×4] /pose-heads unreachable (${err.message}) — bodies head-check falls back to Gemini`);
  }
  return null;
}

async function detectSheetRowDivider(imageData, buf, W, H) {
  try {
    const url = (process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000') + '/split-reference-sheet';
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData, count: 8, cols: 4, rows: 2 }),
      signal: AbortSignal.timeout(60_000),
    });
    if (r.ok) {
      const j = await r.json();
      const h = j?.separators?.horizontal;
      if (j?.success && Array.isArray(h) && h.length && h[0] > 0 && h[0] < H) return Math.round(h[0]);
    }
    log.warn(`[CHARACTER 2×4] split-reference-sheet gave no horizontal separator — falling back to variance detector`);
  } catch (err) {
    log.warn(`[CHARACTER 2×4] split-reference-sheet unreachable (${err.message}) — falling back to variance detector`);
  }
  const { detectMinVarianceSeparator } = require('./grok');
  const { data } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  return detectMinVarianceSeparator(data, W, H, 'h', 0.25, 0.75);
}

async function splitSheetRows(imageData) {
  const buf = Buffer.from(r2.stripDataUriPrefix(imageData), 'base64');
  const { width: W, height: H } = await sharp(buf).metadata();
  const mid = await detectSheetRowDivider(imageData, buf, W, H);
  const [top, bottom] = await Promise.all([
    sharp(buf).extract({ left: 0, top: 0, width: W, height: mid }).jpeg().toBuffer(),
    sharp(buf).extract({ left: 0, top: mid, width: W, height: H - mid }).jpeg().toBuffer(),
  ]);
  return {
    topHeads: 'data:image/jpeg;base64,' + top.toString('base64'),
    bottomBody: 'data:image/jpeg;base64,' + bottom.toString('base64'),
    splitY: mid, width: W, height: H,
  };
}

const inlinePartOf = (dataUri) => ({ inline_data: { mime_type: dataUri.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg', data: r2.stripDataUriPrefix(dataUri) } });

// STRUCTURE eval of one cropped row — crop ALONE, no reference images. This is
// deliberate: the reference faces (photo/avatar) contain heads, and with them
// in-context the judge answers "is the head visible" from the reference, not the
// sheet (it scored a headless bottom crop "head yes, 8"). With the crop alone it
// judges what's actually there. which='heads' → sheet-row-heads-eval (heads-only
// / angles / clean); 'bodies' → sheet-row-bodies-eval (head-to-toe / angles /
// outfit / proportions). Identity is a SEPARATE call — see evaluateIdentity.
async function evaluateSheetRow(rowImageData, which, opts = {}) {
  const { costumeDescription = '', costumeName = null, model = 'gemini-2.5-flash', promptOverride = null, usageTracker = null } = opts;
  const tplKey = which === 'heads' ? 'sheetRowHeadsEval' : 'sheetRowBodiesEval';
  let prompt = promptOverride || PROMPT_TEMPLATES[tplKey];
  if (!prompt) throw new Error(`${tplKey} template not loaded`);
  if (which === 'bodies') {
    prompt = fillTemplate(prompt, {
      REQUESTED_OUTFIT: costumeDescription ? `REQUESTED_OUTFIT: ${costumeDescription}` : '',
      REQUESTED_COSTUME: costumeName ? `REQUESTED_COSTUME: ${costumeName}` : '',
    });
  }
  const parts = [inlinePartOf(rowImageData), { text: prompt }];
  // 8000 not 4000: gemini-2.5 thinking counts toward maxOutputTokens, and the
  // costumeReads enumeration lengthened the bodies JSON — a 4000 cap truncated
  // it mid-string, and the throw cost three characters their whole ref sheet.
  const { text, usageMetadata } = await callSheetJudge(model, parts, 8000, process.env.GEMINI_API_KEY);
  if (!text) throw new Error(`row eval (${which}, ${model}) returned no text`);
  if (usageTracker && usageMetadata) {
    usageTracker('gemini_quality', { input_tokens: usageMetadata.promptTokenCount || 0, output_tokens: usageMetadata.candidatesTokenCount || 0 }, `character_2x4_${which}_eval`, model);
  }
  return { report: parseJudgeJson(text), promptUsed: prompt };
}

// IDENTITY eval — reference faces (photo + avatar faces) + the HEADS crop only.
// Identity is a face question, so it runs on the head row; the body row's
// identity is not relevant (user direction). Returns {perCell, identityScore}.
async function evaluateIdentity(headsCrop, opts = {}) {
  const { sourcePhoto = null, avatarFaces = null, model = 'gemini-2.5-flash', usageTracker = null } = opts;
  const prompt = PROMPT_TEMPLATES.sheetRowIdentityEval;
  if (!prompt) throw new Error('sheetRowIdentityEval template not loaded');
  const parts = [];
  if (sourcePhoto) parts.push(inlinePartOf(sourcePhoto));
  if (avatarFaces) parts.push(inlinePartOf(avatarFaces));
  parts.push(inlinePartOf(headsCrop));
  parts.push({ text: prompt });
  // 8000: same gemini-2.5 thinking-token trap as the row/style evals — a low
  // cap truncates the JSON. maxOutputTokens is a ceiling, not a charge.
  const { text, usageMetadata } = await callSheetJudge(model, parts, 8000, process.env.GEMINI_API_KEY);
  if (!text) throw new Error(`identity eval (${model}) returned no text`);
  if (usageTracker && usageMetadata) {
    usageTracker('gemini_quality', { input_tokens: usageMetadata.promptTokenCount || 0, output_tokens: usageMetadata.candidatesTokenCount || 0 }, 'character_2x4_identity_eval', model);
  }
  return { report: parseJudgeJson(text), promptUsed: prompt };
}

// Shared split evaluator — the SINGLE implementation used by BOTH production
// (generateCharacter2x4Sheet) and the Test Lab, so they judge identically.
// THREE calls: (1) heads structure — crop alone; (2) bodies structure — crop
// alone; (3) identity — reference faces + the heads crop. Structure never sees
// the reference faces (so the head-check can't be fooled by them); identity uses
// them but only against the heads. Returns the sub-reports + a merged `verdict`
// whose flat fields are a drop-in for the whole-sheet verdict the retry gate reads.
async function evaluateSheetSplit(sheetImageData, opts = {}) {
  const { facePhoto = null, standardAvatar = null, costumeDescription = 'standard outfit', costumeName = null, model = 'gemini-2.5-flash', promptOverride = null, usageTracker = null } = opts;
  const avatarFaces = standardAvatar ? (await splitSheetRows(standardAvatar)).topHeads : null;
  const { topHeads, bottomBody, splitY } = await splitSheetRows(sheetImageData);
  const hasRefs = !!(facePhoto || avatarFaces);
  const [headsR, bodiesR, identityR, poseHeads] = await Promise.all([
    evaluateSheetRow(topHeads, 'heads', { model, promptOverride, usageTracker }),
    // Bodies row (flash): feet / angles / outfit / proportions / background. It
    // does NOT judge head presence — a VLM hallucinates a head on a headless torso
    // (POPE-adversarial co-occurrence) — so the head axis is owned by pose
    // (detectBodyRowHeads) and merged in below. ONE source of truth per concept.
    evaluateSheetRow(bottomBody, 'bodies', { costumeDescription, costumeName, model, promptOverride, usageTracker }),
    hasRefs ? evaluateIdentity(topHeads, { sourcePhoto: facePhoto, avatarFaces, model, usageTracker }) : Promise.resolve(null),
    detectBodyRowHeads(bottomBody),
  ]);
  const heads = headsR.report, bodies = bodiesR.report;
  const identity = identityR?.report || null;
  const idScore = identity?.identityScore ?? 10;

  // HEAD GATE — pose owns "is there a head" on the body row, Gemini owns
  // feet/outfit/etc.; applyPoseHeadGate merges them (shared with the decoupled
  // generator so there is ONE gate). Mutates `bodies` (fullBodyScore/finalScore/
  // valid/headSource). poseHeads === null → loud Gemini fallback.
  applyPoseHeadGate(bodies, poseHeads);

  // finalScore spans structure of both rows + identity (heads only).
  const finalScore = Math.min(heads?.finalScore ?? 0, bodies?.finalScore ?? 0, idScore);
  const verdict = {
    split: true, splitY, finalScore, valid: finalScore >= 6,
    failureReasons: [...(heads?.failureReasons || []), ...(bodies?.failureReasons || [])],
    layout: { layoutScore: bodies?.fullBody?.fullBodyScore ?? 10 },
    identity: { identityScore: idScore, reason: identity?.reason },
    outfit: { outfitScore: bodies?.outfit?.outfitScore ?? 10 },
    sourceMatch: { sourceMatchScore: idScore },
    cleanRender: { cleanScore: heads?.cleanRender?.cleanScore ?? 10 },
    heads, bodies, identityReport: identity,
  };
  // Each call's prompt as its OWN labeled entry (3 separate calls, not one blob).
  const prompts = [
    { label: 'Heads — structure (crop only)', text: headsR.promptUsed },
    { label: 'Bodies — structure (crop only)', text: bodiesR.promptUsed },
    ...(identityR ? [{ label: 'Identity (reference faces + heads crop)', text: identityR.promptUsed }] : []),
  ];
  const promptUsed = prompts.map(p => `— ${p.label} —\n${p.text}`).join('\n\n');
  return { verdict, heads, bodies, identity, topHeads, bottomBody, avatarFaces, splitY, prompts, promptUsed };
}

/**
 * SINGLE SOURCE OF TRUTH for scoring an avatar 2×4 sheet.
 *
 * Production (pass 1 in generateCharacter2x4Sheet, pass 2 in runStyleTransferPass)
 * AND the Test Lab (runAvatarEvalStage) all call THIS — never their own copy — so
 * a lab verdict is always the production verdict. The ONLY way the lab can differ
 * is an explicit promptOverride/model (a recorded experiment), never a separate
 * code path. Owner rule (2026-08-08): lab == production by construction.
 *
 *   pass 1 (realistic base) → evaluateSheetSplit: head row + body row + identity
 *                             judged SEPARATELY (this is the only place the
 *                             "does each body have a head" check runs).
 *   pass 2 (styled)         → evaluateStyledSheetWithGemini: holistic identity /
 *                             style / outfit. Style transfer re-renders an
 *                             existing good sheet and cannot lose heads, so no
 *                             per-cell head/body check is run here.
 *
 * Always returns a normalised shape: { verdict, split } — verdict is the drop-in
 * (finalScore/valid/…); split is the pass-1 detail (heads/bodies/identity/crops/
 * prompts) or null on pass 2.
 */
async function evaluateAvatarSheet(sheet, opts = {}) {
  const {
    pass, facePhoto = null, standardAvatar = null, realisticSheet = null,
    costumeDescription = 'standard outfit', costumeName = null, artStyle = 'watercolor',
    declaredAge = null, model = null, promptOverride = null, usageTracker = null,
  } = opts;
  if (Number(pass) === 1) {
    const split = await evaluateSheetSplit(sheet, {
      facePhoto, standardAvatar, costumeDescription, costumeName,
      model: model || MODEL_DEFAULTS.sheetEvalModel, promptOverride, usageTracker,
    });
    return { verdict: split.verdict, split };
  }
  const styled = await evaluateStyledSheetWithGemini(
    facePhoto, realisticSheet, sheet, artStyle, process.env.GEMINI_API_KEY,
    usageTracker, declaredAge, { model: model || undefined, promptOverride }
  );
  return { verdict: styled, split: null };
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
    // The costume's own name ('pirate', 'knight'). Separate from the garment
    // prose deliberately: costumeDescription is stored and reused verbatim in
    // scene prompts, so the name must not be smuggled into that string.
    costumeName = null,
    artStyle = 'watercolor',
    usageTracker = null,
    skipQualityEval = false,
    // redress=true → the story outfit differs from the stored avatar's clothing;
    // dress the body cells purely from costumeDescription and ignore Image 2's
    // (old) clothing. Set by the caller when clothingRequirements ≠ stored.
    redress = false,
  } = opts;

  const facePhoto = await resolveFacePhoto(character);
  if (!facePhoto) {
    throw new Error(`No face photo for ${character?.name || 'character'}.`);
  }
  const standardAvatar = await resolveStandardAvatar(character);

  // ── PASS 1 (realistic anchor) — DECOUPLED two-call generation with review ──
  // A single combined 2×4 call produced a headless bottom row ~70% of the time
  // (reproduced with identical params, not variance — see docs/decisions.md).
  // Split into a full-body row, then a head-shot row that references the
  // ACCEPTED body, each reviewed with ≤1 retry (keep least-bad), then
  // composited. generateComposited2x4 owns that loop and returns a verdict in
  // the evaluateSheetSplit shape, so Pass 2 and the return below are unchanged.
  // skipReview mirrors the old skipQualityEval fast path (1 try each, no eval).
  let composed;
  try {
    composed = await generateComposited2x4(character, {
      costumeDescription, costumeName, redress, usageTracker, skipReview: skipQualityEval,
    });
  } catch (err) {
    throw new Error(`[CHARACTER 2×4] pass-1 generation failed for ${character?.name}: ${err.message}`);
  }
  const verdict = composed.verdict;
  log.info(`[CHARACTER 2×4] ${character?.name} pass-1 (decoupled 2-call): layout=${verdict.layout?.layoutScore} identity=${verdict.identity?.identityScore} outfit=${verdict.outfit?.outfitScore} final=${verdict.finalScore} valid=${verdict.valid}`);

  const pass1 = {
    imageData: composed.imageData,
    selectedAttempt: 1,
    finalScore: verdict.finalScore,
    finalVerdict: verdict,
    attempts: composed.attemptHistory,
    prompt: composed.prompt,
    bodyRow: composed.bodyRow,
    headRow: composed.headRow,
    sentToGrok: null,
  };

  // ── PASS 2: style transfer (always runs when artStyle is non-realistic) ─
  // Previously gated on pass1.finalScore >= 6 to avoid styling a broken
  // sheet. Removed (2026-05-17 per user direction) — the quickLayoutCheck
  // is over-eager and was rejecting structurally-fine sheets, then Pass 2
  // skipped, then the character shipped as a realistic photo embedded in
  // a watercolour story. The outer Face/Clothing eval still gates the
  // final selection, so a truly broken sheet won't ship either way. Every
  // non-realistic art style now gets style transfer applied.
  // `skipQualityEval` means "don't spend Gemini calls GRADING this sheet". It
  // must NOT mean "don't convert the art style" — those are unrelated, and
  // conflating them reproduced the exact failure the comment above warns
  // about: the trial (which sets skipQualityEval) shipped realistic Pass-1
  // photo sheets as references into a watercolour story, so `standard` and
  // costumed pages alike rendered as painted photographs
  // (job_1786909179342: pass2 recorded as null, no character_2x4_style_transfer
  // in api_usage). Pass 2 always runs for a non-realistic style; the flag is
  // forwarded so the pass itself takes 1 attempt and skips its own reviews.
  const wantStyleTransfer = artStyle && artStyle !== 'realistic';
  let pass2 = null;
  if (wantStyleTransfer) {
    // Pass-2 failure must NEVER destroy the avatar: the Pass-1 realistic
    // sheet is a complete identity anchor on its own, so any throw here is
    // downgraded to "ship Pass 1 unstyled". runStyleTransferPass already
    // catches per-attempt backend errors + does an alternate-engine retry;
    // this outer catch is defence in depth for anything unexpected.
    try {
      pass2 = await runStyleTransferPass({
        pass1ImageData: pass1.imageData,
        facePhoto,
        artStyle,
        characterName: character?.name,
        characterAge: character?.age,
        usageTracker,
        skipQualityEval,
      });
    } catch (err) {
      log.error(`[CHARACTER 2×4] ${character?.name} Pass 2 threw unexpectedly: ${err.message} — shipping realistic Pass 1 sheet unstyled`);
      pass2 = null;
    }
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
    usage: composed.usage,
    prompt: pass1.prompt,
    refs: {
      phantom: composed.refs?.phantom || null,
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
async function runStyleTransferPass({ pass1ImageData, facePhoto, artStyle, characterName, characterAge = null, usageTracker, promptOverride = null, backendOverride = null, skipQualityEval = false }) {
  // Optional per-style anchor image (Image 2). The prompt references it only
  // when present; styleTransferGenerate passes it as the 2nd reference.
  const styleAnchor = loadStyleAnchor(artStyle);
  // promptOverride: Test Lab A/B — full replacement for the style-transfer
  // prompt (buildStyleTransferPrompt output), this call only.
  const prompt = promptOverride || buildStyleTransferPrompt(artStyle, { hasAnchor: !!styleAnchor });
  if (styleAnchor) log.info(`[CHARACTER 2×4] ${characterName} Pass 2 using style anchor (style-anchor-${artStyle})`);
  const totalAttempts = 1 + MAX_SHEET_RETRIES;
  const attempts = [];
  let best = null;

  const trackUsage = (result) => {
    if (usageTracker && result.usage) {
      // Image models are priced per image, not per token — without an explicit
      // cost the tracker falls into token-rate lookup, finds none for image
      // models, and poisons the run total with NaN (observed: $NaN TOTAL on
      // the 2026-07-21 run via gemini-3-pro style transfer).
      const { MODEL_PRICING } = require('../config/models');
      const usage = {
        ...result.usage,
        cost: result.usage.cost ?? MODEL_PRICING[result.modelId]?.perImage ?? 0.04,
      };
      usageTracker(result.provider || 'grok', usage, 'character_2x4_style_transfer', result.modelId);
    }
  };

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    log.info(`[CHARACTER 2×4] ${characterName} Pass 2 (style=${artStyle}, backend=${MODEL_DEFAULTS.avatarStyleTransferBackend}) attempt ${attempt}/${totalAttempts}`);
    // A thrown backend call consumes ONE attempt — it must never escape this
    // loop. Previously this line was unprotected: one Gemini IMAGE_OTHER
    // safety refusal (photorealistic ADULT face on the Pass-1 sheet) threw
    // out of runStyleTransferPass AND out of generateCharacter2x4Sheet,
    // destroying the perfectly good Pass-1 identity anchor. That is how an
    // adult primary character ended up with ZERO styled avatars on staging
    // (costumed sheet died here, then the standard-fallback sheet died on the
    // same refusal). See docs/decisions.md "Styled-avatar MUST guarantee".
    let result;
    try {
      result = await styleTransferGenerate(prompt, pass1ImageData, backendOverride, styleAnchor);
    } catch (err) {
      log.warn(`[CHARACTER 2×4] ${characterName} Pass 2 attempt ${attempt}/${totalAttempts} (${MODEL_DEFAULTS.avatarStyleTransferBackend}) threw: ${err.message}${attempt < totalAttempts ? ' — retrying' : ''}`);
      attempts.push({ attempt, stage: 'gen-error', score: 0, reason: err.message });
      continue;
    }
    trackUsage(result);

    // skipQualityEval covers pass 2 as well: the caller asked for no reviews
    // (trial has no repair stage and cannot act on a verdict), so accept the
    // first style transfer instead of scoring and retrying it.
    if (!process.env.GEMINI_API_KEY || skipQualityEval) {
      if (!process.env.GEMINI_API_KEY) log.warn('[CHARACTER 2×4] GEMINI_API_KEY missing — accepting Pass 2 after first attempt');
      best = { result, attempt, score: 10, verdict: null };
      attempts.push({ attempt, stage: skipQualityEval ? 'no-eval-requested' : 'no-eval-key', score: 10, imageData: result.imageData, sentToGrok: result.sentToGrok || null });
      break;
    }

    // Pass-2 eval via the single-source evaluator — holistic styled eval, no
    // head/body split (style transfer can't lose heads). SAME call the lab
    // makes. Restored after the row-harmonise removal (5bb2c3423) deleted the
    // assignment but left every reader of `verdict` in place: with reviews ON
    // this threw ReferenceError right after paying for the style transfer, the
    // outer catch downgraded it to "ship Pass 1 unstyled", and every full-story
    // character silently shipped as a realistic photo in a painted story.
    let verdict = null;
    try {
      ({ verdict } = await evaluateAvatarSheet(result.imageData, {
        pass: 2, facePhoto, realisticSheet: pass1ImageData, artStyle, declaredAge: characterAge, usageTracker,
      }));
      log.info(`[CHARACTER 2×4]   Pass 2 eval: layout=${verdict.layoutScore} identity=${verdict.identityScore} style=${verdict.styleScore} outfit=${verdict.outfitScore} clean=${verdict.cleanScore} bodyFace=${verdict.bodyFaceScore} age=${verdict.ageScore ?? '-'} final=${verdict.finalScore} valid=${verdict.valid}`);
    } catch (err) {
      // Mirror Pass-1 behaviour: a Gemini eval failure must NOT lock in this
      // attempt at the maximum score and break the retry loop. Score it
      // neutrally and continue so a later attempt that DOES eval successfully
      // can win the best-of-N comparison.
      log.warn(`[CHARACTER 2×4] Pass 2 eval error attempt ${attempt}: ${err.message} — counting as neutral (score=5) and continuing retries`);
      const candidate = { result, attempt, score: 5, verdict: null };
      attempts.push({ attempt, stage: 'eval-error', score: 5, reason: err.message, imageData: result.imageData, sentToGrok: result.sentToGrok || null });
      if (!best || candidate.score > best.score) best = candidate;
      continue;
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
      cleanScore: verdict.cleanScore,
      bodyFaceScore: verdict.bodyFaceScore,
      reasons: verdict.failureReasons || [],
      imageData: result.imageData,
      sentToGrok: result.sentToGrok || null,
    });
    const candidate = { result, attempt, score, verdict };
    if (!best || candidate.score > best.score) best = candidate;
    if (verdict.valid) break;
    log.warn(`[CHARACTER 2×4] ${characterName} Pass 2 attempt ${attempt} score=${score} (valid=false)`);
  }

  // A sheet whose two rows disagree on garment colour is caught by the STYLE
  // EVAL, not by arithmetic here (owner, 2026-08-15): prompts/sheet-2x4-style-eval.txt
  // task 3 scores partial style transfer 4-6, and task 4 requires the same
  // colours across cells. A colour-only mechanism used to duplicate that check
  // and force its own retry; it was removed because it could not separate a
  // pale garment (chroma 9.8) from JPEG speckle on the white backdrop (4-8),
  // and both of its failure modes still measured "rows agree".
  const winningImage = best.result.imageData;

  return {
    imageData: winningImage,
    selectedAttempt: best.attempt,
    finalScore: best.score,
    finalVerdict: best.verdict,
    // Echo the backend/model that actually produced the winning sheet, so
    // callers (Test Lab) record the true model per result instead of a label.
    provider: best.result.provider || null,
    modelId: best.result.modelId || null,
    attempts,
    prompt,
    sentToGrok: best.result.sentToGrok || null,
  };
}

module.exports = {
  generateCharacter2x4Sheet,
  loadPhantom,
  // Standalone Pass 2 (style transfer from an existing realistic sheet) +
  // face-photo resolver — used by Test Lab to reuse one realistic anchor
  // across many style transfers.
  runStyleTransferPass,
  resolveFacePhoto,
  buildStyleTransferPrompt,
  // exposed for tests
  _internal: { parseJudgeJson, buildPrompt, buildStyleTransferPrompt, resolveFacePhoto, resolveStandardAvatar, quickLayoutCheck, evaluateSheetWithGemini, evaluateStyledSheetWithGemini, runStyleTransferPass, splitSheetRows, evaluateSheetRow, evaluateIdentity, evaluateSheetSplit, evaluateAvatarSheet },
};
