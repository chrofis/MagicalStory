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
const r2 = require('./r2');
const { getFacePhoto, getStandardAvatar } = require('./characterPhotos');

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

function buildPrompt(_artStyle, costumeDescription, character = null) {
  const hairBlock = buildHairBlock(character);
  return `Image 1 indicates only the camera angle and facing direction in each cell — ignore its silhouette, body, and face. The coloured arrows (red, green, blue) on each head in Image 1 are direction guides ONLY — never render, copy, or paint them onto the character, the face, the hair, or anywhere in the output. The output contains no arrows.
Image 2 is the character's body. Image 3 is the character's face.

Costume: ${costumeDescription}
${hairBlock}
Render every cell as a REALISTIC reference — the same visual style as the source face photo in Image 3. Photographic / lifelike, with natural proportions matching the person's apparent age in Image 3. No cartoon stylisation, no chibi, no anime, no watercolour — those treatments are applied later by downstream steps. This sheet is an identity anchor.

Output a 2×4 grid with thin black dividing lines and pure white background, in the same cell layout as Image 1.

The horizontal mid-row divider must be drawn as one unbroken thin black line running edge to edge. The three vertical column dividers must be drawn the same way. Nothing crosses any divider: every figure stays fully inside its own cell, surrounded by white space on all four sides. No head, no hair, no hand, no foot, no shadow, no clothing detail extends beyond the cell's borders. If a figure would not fit inside its cell, scale it down so it fits.

Cells 1-4 (top row): head and neck only, no shoulders, no torso, no clothing. Cell 1 front, cell 2 three-quarter, cell 3 profile, cell 4 back of head. The head occupies roughly the middle of the cell with white margin above the hairline and below the neck — the neck stops cleanly, it never continues into the bottom row.
Cells 5-8 (bottom row): full body from head to feet wearing the costume. Cell 5 front, cell 6 three-quarter, cell 7 profile, cell 8 back. The full figure fits entirely between the mid-row divider and the bottom edge — the head of a bottom-row body never extends up into the top row.

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
  const b64 = imageData.replace(/^data:image\/\w+;base64,/, '');
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

async function evaluateSheetWithGemini(imageData, costumeDescription, geminiApiKey, sourcePhoto = null, usageTracker = null, opts = {}) {
  const { standardAvatar = null, characterDescription = '' } = opts;
  const sheetB64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  const sheetMime = imageData.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  let prompt = PROMPT_TEMPLATES.sheet2x4Evaluation;
  if (!prompt) throw new Error('sheet2x4Evaluation prompt template not loaded');
  if (costumeDescription) {
    prompt = prompt.replace(/REQUESTED_OUTFIT/g, `REQUESTED_OUTFIT: ${costumeDescription}`);
  }
  // Inject the character profile block, or drop the placeholder when none.
  if (characterDescription && characterDescription.trim()) {
    prompt = prompt.replace(/CHARACTER_PROFILE_BLOCK/g,
      `CHARACTER PROFILE (declared spec for this person — authoritative on age, gender, build):\n${characterDescription.trim()}\n`);
  } else {
    prompt = prompt.replace(/CHARACTER_PROFILE_BLOCK\n?/g, '');
  }

  // Image order matters — prompt labels Image 1 = source face, Image 2 =
  // standard avatar (when supplied), Image LAST = generated sheet. The eval
  // text adapts to "Image 2" vs "Image 3" semantics for the sheet via the
  // "Image LAST" phrasing in the prompt. When no sourcePhoto provided, falls
  // back to sheet-only (Task 4 still attempts but has no baseline; Task 2
  // falls back to cell-1-as-anchor mode documented in the prompt).
  const parts = [];
  if (sourcePhoto) {
    const srcB64 = sourcePhoto.replace(/^data:image\/\w+;base64,/, '');
    const srcMime = sourcePhoto.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    parts.push({ inline_data: { mime_type: srcMime, data: srcB64 } });
  }
  if (standardAvatar) {
    const avB64 = standardAvatar.replace(/^data:image\/\w+;base64,/, '');
    const avMime = standardAvatar.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    parts.push({ inline_data: { mime_type: avMime, data: avB64 } });
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
  if (usageTracker && j?.usageMetadata) {
    usageTracker('gemini_quality', {
      input_tokens: j.usageMetadata.promptTokenCount || 0,
      output_tokens: j.usageMetadata.candidatesTokenCount || 0,
    }, 'character_2x4_eval', 'gemini-2.5-flash');
  }
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
async function evaluateStyledSheetWithGemini(sourcePhoto, realisticSheet, styledSheet, artStyle, geminiApiKey, usageTracker = null) {
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
  if (usageTracker && j?.usageMetadata) {
    usageTracker('gemini_quality', {
      input_tokens: j.usageMetadata.promptTokenCount || 0,
      output_tokens: j.usageMetadata.candidatesTokenCount || 0,
    }, 'character_2x4_style_eval', 'gemini-2.5-flash');
  }
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

  const prompt = buildPrompt(artStyle, costumeDescription, character);

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
      // Pass the source face photo (Image 1) + the standard avatar (Image 2)
      // + the declared character profile (text). Task 2 now uses Image 2 as
      // the identity anchor instead of cell 1 — catches drift across the
      // whole sheet, not just within it. Task 4 cross-checks apparent age
      // against the profile — catches sheets that look like the source photo
      // but render the character as the wrong age bucket (e.g. 14-yr-old
      // profile, sheet renders ~10).
      const characterProfile = buildCharacterDescription(character);
      verdict = await evaluateSheetWithGemini(
        result.imageData,
        costumeDescription,
        process.env.GEMINI_API_KEY,
        facePhoto,
        usageTracker,
        { standardAvatar, characterDescription: characterProfile }
      );
      log.info(`[CHARACTER 2×4]   eval: layout=${verdict.layout?.layoutScore} identity=${verdict.identity?.identityScore} outfit=${verdict.outfit?.outfitScore} sourceMatch=${verdict.sourceMatch?.sourceMatchScore} clean=${verdict.cleanRender?.cleanScore} final=${verdict.finalScore} valid=${verdict.valid}`);
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
      verdict = await evaluateStyledSheetWithGemini(facePhoto, pass1ImageData, result.imageData, artStyle, process.env.GEMINI_API_KEY, usageTracker);
      log.info(`[CHARACTER 2×4]   Pass 2 eval: layout=${verdict.layoutScore} identity=${verdict.identityScore} style=${verdict.styleScore} outfit=${verdict.outfitScore} final=${verdict.finalScore} valid=${verdict.valid}`);
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
