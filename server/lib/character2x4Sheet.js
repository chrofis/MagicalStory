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
const { measureRowConsistency, harmonizeSheetRows } = require('./sheetRowHarmonize');

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
async function styleTransferGenerate(prompt, pass1ImageData, backendOverride = null) {
  const backend = backendOverride || MODEL_DEFAULTS.avatarStyleTransferBackend;
  if (backend === 'gemini') {
    const r = await editWithGeminiImage(prompt, [pass1ImageData], { aspectRatio: '16:9', model: MODEL_DEFAULTS.avatarStyleTransferModel });
    return { ...r, provider: 'gemini_image' };
  }
  const r = await editWithGrok(prompt, [pass1ImageData], { aspectRatio: '16:9', model: GROK_MODELS.STANDARD });
  return { ...r, provider: 'grok' };
}

// Best-of-N cap: first attempt + N retries. The loop short-circuits on the
// first valid eval — retries only fire when an attempt fails. If all attempts
// fail, we pick the best and ship it. Two retries = up to 3 Grok calls per pass.
const MAX_SHEET_RETRIES = 2;

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

function buildPrompt(_artStyle, costumeDescription, character = null, redress = false) {
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
  const outfitRule = redress
    ? `Costume (the ONLY outfit — every body cell wears exactly this, NOT the clothing from Image 2): ${costumeDescription}`
    : `Costume: ${costumeDescription}`;
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
      generationConfig: { temperature: 0.2, maxOutputTokens, responseMimeType: 'application/json' },
      safetySettings: SHEET_JUDGE_SAFETY,
    };
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${geminiApiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }
    );
    if (!resp.ok) throw new Error(`Gemini eval HTTP ${resp.status}`);
    const j = await resp.json();
    return { text: j?.candidates?.[0]?.content?.parts?.[0]?.text, usageMetadata: j?.usageMetadata };
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
  if (first >= 0 && last > first) return JSON.parse(s.slice(first, last + 1));
  throw new Error(`judge returned non-JSON: ${s.slice(0, 160)}`);
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

function buildStyleTransferPrompt(artStyle) {
  const styleLine = resolveStyleLineForSheet(artStyle);
  return `Re-render this 2×4 character reference sheet in ${styleLine}.

Apply this exact same art style to ALL 8 cells equally. Every one of the 8 cells shows the SAME character rendered in the identical ${styleLine} treatment — the four head cells (top row) and the four full-body cells (bottom row) must match in rendering style, shading, skin finish, and degree of stylisation. No cell may stay photographic or semi-realistic while the others are stylised; the bottom-row full-body figures must look rendered in exactly the same style as the top-row heads.

Preserve EVERYTHING except the visual style:
- Same 4-column × 2-row grid layout, same thin black dividers, same pure white background. Add no scenery, environment, weather, streets, buildings, or background of any kind — the background stays pure white and empty in all 8 cells. Apply the style only to the figure.
- Top row cells 1-4: head and neck only, in the same order (front, three-quarter, profile, back). Same hair, same beard if any, same skin tone, same facial features — the same person.
- Bottom row cells 5-8: full body head to feet in the same poses (front, three-quarter, profile, back), both feet and shoes fully visible exactly as in the source sheet — never crop at the thigh, knee, or ankle. Same costume — every accessory, every garment colour, every cut identical. Keep body proportions age-appropriate and matched to the head: an adult is roughly 7 to 8 heads tall, a teenager about 7 heads, a young child about 5 to 6 heads, a toddler about 4 heads. Do NOT shrink an adult into child-like proportions and do NOT put an oversized head on a small body — the full-body figures must read as the same age as the head cells.
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
  const { text, usageMetadata } = await callSheetJudge(model, parts, 8000, geminiApiKey);
  if (!text) throw new Error(`style-eval (${model}) returned no text`);
  if (usageTracker && usageMetadata) {
    usageTracker('gemini_quality', {
      input_tokens: usageMetadata.promptTokenCount || 0,
      output_tokens: usageMetadata.candidatesTokenCount || 0,
    }, 'character_2x4_style_eval', model);
  }
  return parseJudgeJson(text);
}

// Split a 2×4 sheet into its top (4 heads) and bottom (4 bodies) rows. The head
// row and body row are NOT equal height, so the divider is NOT at H/2. We locate
// the actual divider line with the SAME production detector used to split avatar
// grids (grok.detectMinVarianceSeparator): the divider — a thin black/white line
// — is near-uniform, so it sits at the minimum-variance row within 0.25–0.75 H.
async function splitSheetRows(imageData) {
  const { detectMinVarianceSeparator } = require('./grok');
  const buf = Buffer.from(r2.stripDataUriPrefix(imageData), 'base64');
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const mid = detectMinVarianceSeparator(data, W, H, 'h', 0.25, 0.75);
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
  const { costumeDescription = '', model = 'gemini-2.5-flash', promptOverride = null, usageTracker = null } = opts;
  const tplKey = which === 'heads' ? 'sheetRowHeadsEval' : 'sheetRowBodiesEval';
  let prompt = promptOverride || PROMPT_TEMPLATES[tplKey];
  if (!prompt) throw new Error(`${tplKey} template not loaded`);
  if (which === 'bodies') {
    prompt = fillTemplate(prompt, { REQUESTED_OUTFIT: costumeDescription ? `REQUESTED_OUTFIT: ${costumeDescription}` : '' });
  }
  const parts = [inlinePartOf(rowImageData), { text: prompt }];
  const { text, usageMetadata } = await callSheetJudge(model, parts, 4000, process.env.GEMINI_API_KEY);
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
  const { text, usageMetadata } = await callSheetJudge(model, parts, 2000, process.env.GEMINI_API_KEY);
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
  const { facePhoto = null, standardAvatar = null, costumeDescription = 'standard outfit', model = 'gemini-2.5-flash', promptOverride = null, usageTracker = null } = opts;
  const avatarFaces = standardAvatar ? (await splitSheetRows(standardAvatar)).topHeads : null;
  const { topHeads, bottomBody, splitY } = await splitSheetRows(sheetImageData);
  const hasRefs = !!(facePhoto || avatarFaces);
  const [headsR, bodiesR, identityR] = await Promise.all([
    evaluateSheetRow(topHeads, 'heads', { model, promptOverride, usageTracker }),
    evaluateSheetRow(bottomBody, 'bodies', { costumeDescription, model, usageTracker }),
    hasRefs ? evaluateIdentity(topHeads, { sourcePhoto: facePhoto, avatarFaces, model, usageTracker }) : Promise.resolve(null),
  ]);
  const heads = headsR.report, bodies = bodiesR.report;
  const identity = identityR?.report || null;
  const idScore = identity?.identityScore ?? 10;
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
    // redress=true → the story outfit differs from the stored avatar's clothing;
    // dress the body cells purely from costumeDescription and ignore Image 2's
    // (old) clothing. Set by the caller when clothingRequirements ≠ stored.
    redress = false,
  } = opts;

  const phantom = loadPhantom(character?.age);
  const facePhoto = await resolveFacePhoto(character);
  if (!facePhoto) {
    throw new Error(`No face photo for ${character?.name || 'character'}.`);
  }
  const standardAvatar = await resolveStandardAvatar(character);
  // The standard avatar is the preferred body reference. If it's missing
  // (e.g. avatar generation failed earlier), fall back to face-only —
  // Grok will rebuild the body from the prompt.
  const refs = standardAvatar
    ? [phantom, standardAvatar, facePhoto]
    : [phantom, facePhoto];

  const prompt = buildPrompt(artStyle, costumeDescription, character, redress);

  // Track every attempt — when all retries fail to produce a `valid` sheet
  // (per the eval), we pick the highest-scoring attempt instead of throwing.
  // Better to ship the least-bad sheet and surface the attempt history in
  // the dev panel than to fail the whole story on a marginal eval miss.
  const attemptHistory = [];
  let bestAttempt = null;  // { result, score, verdict|null, quick|null }
  const totalAttempts = 1 + MAX_SHEET_RETRIES;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    log.info(`[CHARACTER 2×4] Generating sheet for ${character?.name} (${clothingCategory}, ${artStyle}, refs=${refs.length}, attempt ${attempt}/${totalAttempts})`);
    // A thrown Grok call must consume ONE attempt, not abort the whole sheet.
    // Previously this line was unprotected, so a single transient API error
    // (timeout, 5xx, refusal) escaped the retry loop, propagated out of
    // generateCharacter2x4Sheet, and the character lost its avatar entirely
    // even though two retries remained.
    let result;
    try {
      result = await editWithGrok(prompt, refs, { aspectRatio: '16:9', model: GROK_MODELS.STANDARD });
    } catch (err) {
      log.warn(`[CHARACTER 2×4] ${character?.name} attempt ${attempt}/${totalAttempts} Grok generation threw: ${err.message}${attempt < totalAttempts ? ' — retrying' : ' — no attempts left'}`);
      attemptHistory.push({ attempt, stage: 'gen-error', score: 0, reason: err.message });
      continue;
    }
    if (usageTracker && result.usage) usageTracker('grok', result.usage, 'character_2x4_sheet', result.modelId);

    if (skipQualityEval) {
      // Caller bypassed eval — first attempt's result IS the result.
      bestAttempt = { result, score: 10, verdict: null, quick: null, attempt };
      attemptHistory.push({ attempt, stage: 'skipped', score: 10, imageData: result.imageData });
      break;
    }

    // Cheap pixel gutter check — ADVISORY ONLY, never a gate. It is over-eager
    // (documented): it false-positives on structurally-fine sheets, and when it
    // did that as a hard gate it scored good versions 0 AND skipped the Gemini
    // eval, so a worse quick-PASSING version won (observed live: 2 good Sarah
    // versions quick-failed → the crap 3rd version was selected). The Gemini eval
    // below is authoritative — it scores layout (catching genuine gutter-crossing
    // via layoutScore), identity, outfit, source-match — so we ALWAYS run it and
    // select by its finalScore. quick is kept only for the dev-panel signal.
    const quick = await quickLayoutCheck(result.imageData);
    if (!quick.valid) {
      log.warn(`[CHARACTER 2×4] ${character?.name} attempt ${attempt} quick-layout advisory: ${quick.reason} — running full Gemini eval anyway (quick check is over-eager, not a gate)`);
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
      // SPLIT eval — the SAME shared evaluator the Test Lab uses. Crops the
      // sheet at the row divider and judges the 4 heads and 4 bodies
      // separately (each anchored on the face photo + the 2×2 avatar's face
      // row), so the judge can't rubber-stamp "bottom row full body" on a crop
      // that isn't, and a cut/missing head is caught. `verdict` is a drop-in
      // for the old whole-sheet shape (finalScore/valid/layout/identity/
      // outfit/sourceMatch/cleanRender/failureReasons).
      const split = await evaluateSheetSplit(result.imageData, {
        facePhoto, standardAvatar, costumeDescription, usageTracker,
        model: MODEL_DEFAULTS.sheetEvalModel,
      });
      verdict = split.verdict;
      log.info(`[CHARACTER 2×4]   split eval: heads=${split.heads?.finalScore} bodies=${split.bodies?.finalScore} layout=${verdict.layout?.layoutScore} identity=${verdict.identity?.identityScore} outfit=${verdict.outfit?.outfitScore} sourceMatch=${verdict.sourceMatch?.sourceMatchScore} clean=${verdict.cleanRender?.cleanScore} final=${verdict.finalScore} valid=${verdict.valid}`);
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
async function runStyleTransferPass({ pass1ImageData, facePhoto, artStyle, characterName, characterAge = null, usageTracker, promptOverride = null, backendOverride = null }) {
  // promptOverride: Test Lab A/B — full replacement for the style-transfer
  // prompt (buildStyleTransferPrompt output), this call only.
  const prompt = promptOverride || buildStyleTransferPrompt(artStyle);
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
      result = await styleTransferGenerate(prompt, pass1ImageData, backendOverride);
    } catch (err) {
      log.warn(`[CHARACTER 2×4] ${characterName} Pass 2 attempt ${attempt}/${totalAttempts} (${MODEL_DEFAULTS.avatarStyleTransferBackend}) threw: ${err.message}${attempt < totalAttempts ? ' — retrying' : ''}`);
      attempts.push({ attempt, stage: 'gen-error', score: 0, reason: err.message });
      continue;
    }
    trackUsage(result);

    if (!process.env.GEMINI_API_KEY) {
      log.warn('[CHARACTER 2×4] GEMINI_API_KEY missing — accepting Pass 2 after first attempt');
      best = { result, attempt, score: 10, verdict: null };
      attempts.push({ attempt, stage: 'no-eval-key', score: 10, imageData: result.imageData, sentToGrok: result.sentToGrok || null });
      break;
    }

    let verdict = null;
    try {
      verdict = await evaluateStyledSheetWithGemini(facePhoto, pass1ImageData, result.imageData, artStyle, process.env.GEMINI_API_KEY, usageTracker, characterAge);
      log.info(`[CHARACTER 2×4]   Pass 2 eval: layout=${verdict.layoutScore} identity=${verdict.identityScore} style=${verdict.styleScore} outfit=${verdict.outfitScore} clean=${verdict.cleanScore} bodyFace=${verdict.bodyFaceScore} age=${verdict.ageScore ?? '-'} final=${verdict.finalScore} valid=${verdict.valid}`);
    } catch (err) {
      // Mirror Pass-1 behaviour (line 414): a Gemini eval failure should NOT
      // lock in this attempt at the maximum score and break the retry loop.
      // Score it neutrally and continue so a later attempt that DOES eval
      // successfully can win the best-of-N comparison.
      log.warn(`[CHARACTER 2×4] Pass 2 eval error attempt ${attempt}: ${err.message} — counting as neutral (score=5) and continuing retries`);
      const candidate = { result, attempt, score: 5, verdict: null };
      attempts.push({ attempt, stage: 'eval-error', score: 5, reason: err.message, imageData: result.imageData, sentToGrok: result.sentToGrok || null });
      if (!best || candidate.score > best.score) best = candidate;
      continue;
    }
    // DETERMINISTIC row-colour gate. The prompt already forbids a sheet whose
    // bottom row stays photographic while the top row is stylised, and the
    // Gemini verdict above is meant to catch it — but it demonstrably passes
    // such sheets (staging: a pink top at chroma 32.8 in the head row and 10.0
    // in the body row scored valid). Colour agreement between the rows is
    // measurable without a model, so measure it and override `valid` rather
    // than trusting the judge on something arithmetic.
    let rowConsistency = null;
    try {
      const { splitY } = await splitSheetRows(result.imageData);
      rowConsistency = await measureRowConsistency(result.imageData, splitY);
      if (!rowConsistency.consistent) {
        verdict.valid = false;
        verdict.failureReasons = [...(verdict.failureReasons || []), `row colour split: ${rowConsistency.reason}`];
        log.warn(`[CHARACTER 2×4] ${characterName} Pass 2 attempt ${attempt}: ${rowConsistency.reason} — forcing retry`);
      }
    } catch (err) {
      // Never let a measurement failure block a sheet that the judge accepted.
      log.warn(`[CHARACTER 2×4] ${characterName} Pass 2 row-consistency check failed: ${err.message} — ignoring`);
    }
    const score = verdict.finalScore ?? 0;
    attempts.push({
      attempt,
      stage: verdict.valid ? 'valid' : 'invalid',
      score,
      rowConsistency,
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

  if (!best) {
    // Every attempt on the configured backend failed (thrown, not just
    // low-scored). Retry ONCE via the alternate engine before giving up on
    // style transfer: Gemini refuses photorealistic adult faces
    // (IMAGE_OTHER), Grok doesn't — and a weakly-stylised Grok sheet still
    // beats shipping no styled avatar at all. No eval on this last-resort
    // attempt (score neutral 5); the identity content is Pass 1's, unchanged.
    const primaryBackend = MODEL_DEFAULTS.avatarStyleTransferBackend === 'gemini' ? 'gemini' : 'grok';
    const altBackend = primaryBackend === 'gemini' ? 'grok' : 'gemini';
    log.warn(`[CHARACTER 2×4] ${characterName} Pass 2: all ${totalAttempts} ${primaryBackend} attempts failed — retrying once via alternate backend (${altBackend})`);
    try {
      const result = await styleTransferGenerate(prompt, pass1ImageData, altBackend);
      trackUsage(result);
      best = { result, attempt: totalAttempts + 1, score: 5, verdict: null };
      attempts.push({ attempt: totalAttempts + 1, stage: 'alt-backend', score: 5, backend: altBackend, imageData: result.imageData, sentToGrok: result.sentToGrok || null });
      log.info(`[CHARACTER 2×4] ${characterName} Pass 2 alternate backend (${altBackend}) succeeded`);
    } catch (err) {
      log.error(`[CHARACTER 2×4] ${characterName} Pass 2 alternate backend (${altBackend}) also failed: ${err.message} — returning Pass 1 unchanged`);
      attempts.push({ attempt: totalAttempts + 1, stage: 'alt-backend-error', score: 0, backend: altBackend, reason: err.message });
    }
  }
  if (!best) {
    log.error(`[CHARACTER 2×4] ${characterName} Pass 2 produced no image after ${totalAttempts} attempts + alternate backend — returning Pass 1 unchanged`);
    return { imageData: null, attempts, selectedAttempt: null, finalScore: 0, finalVerdict: null, prompt };
  }
  if (attempts.length > 1) {
    log.info(`[CHARACTER 2×4] ${characterName} Pass 2 best-of-${attempts.length}: attempt ${best.attempt} (score=${best.score})`);
  }
  // BACKSTOP (opt-in): every retry may still come back row-split — the gate
  // forces retries, it cannot make the model comply. Repainting the washed-out
  // row onto the stylised row's colour is implemented and unit-tested, but it
  // is OFF by default: separating a pale garment from a pale backdrop by colour
  // alone is not reliable (see MODEL_DEFAULTS.avatarSheetRowHarmonize). A sheet
  // that merely disagrees with itself is better than one with pink blotches on
  // the backdrop, so without a figure mask we ship the sheet and let the
  // detection above have done its job via the retries.
  let winningImage = best.result.imageData;
  let rowHarmonize = null;
  if (MODEL_DEFAULTS.avatarSheetRowHarmonize) try {
    const { splitY } = await splitSheetRows(winningImage);
    const h = await harmonizeSheetRows(winningImage, splitY);
    rowHarmonize = { changed: h.changed, authority: h.authority, deltaLab: h.deltaLab, measurement: h.measurement };
    if (h.changed) {
      winningImage = h.imageData;
      log.info(`[CHARACTER 2×4] ${characterName} Pass 2 row-harmonize: ${h.authority} is authority, ΔLab (${h.deltaLab.L}, ${h.deltaLab.a}, ${h.deltaLab.b}) — ${h.measurement.reason}`);
    }
  } catch (err) {
    log.warn(`[CHARACTER 2×4] ${characterName} Pass 2 row-harmonize failed: ${err.message} — shipping the sheet unharmonized`);
  }
  return {
    imageData: winningImage,
    rowHarmonize,
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
  _internal: { buildPrompt, buildStyleTransferPrompt, resolveFacePhoto, resolveStandardAvatar, quickLayoutCheck, evaluateSheetWithGemini, evaluateStyledSheetWithGemini, runStyleTransferPass, splitSheetRows, evaluateSheetRow, evaluateIdentity, evaluateSheetSplit },
};
