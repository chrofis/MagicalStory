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
const { geminiUsage } = require('./providerUsage');
const { editWithGrok, GROK_MODELS } = require('./grok');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { assertPromptFilled, guardPromptString } = require('../services/prompts');
const { MODEL_DEFAULTS } = require('../config/models');
const { analyzerJson, AnalyzerError, reportAnalyzerFailure } = require('./photoAnalyzerClient');
const r2 = require('./r2');
const { getFacePhoto, getStandardAvatar } = require('./characterPhotos');
const { declaredGlasses } = require('./avatarOverrides');
const { assessImageResponse, describeImageBlock, describeImageOutcome } = require('./imageReplyGuard');

// Minimal Gemini image-edit for the avatar style-transfer pass. Same contract
// as editWithGrok (prompt + reference images → { imageData, usage, modelId }).
// Gemini stylises far better than Grok on this BIG transform (all-5 A/B,
// project_image_model_tests.md 2026-07-19); Grok stays on Round 1 (identity).
async function editWithGeminiImage(prompt, refImages, { aspectRatio = '16:9', model = 'gemini-2.5-flash-image' } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing for avatar style transfer');
  prompt = guardPromptString(prompt, 'editWithGeminiImage');
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
  if (!inline) {
    // NAME THE REASON (2026-09-18). This is the exact call a Gemini IMAGE_OTHER
    // refuses on a photorealistic adult-face Pass-1 sheet — see the
    // styled-avatar guarantee in docs/decisions.md — and the message used to be
    // a bare "no image", leaving the operator nothing to act on.
    throw new Error(`Gemini returned no image (style transfer): ${describeImageOutcome(assessImageResponse(j))}`);
  }
  const usage = j?.usageMetadata ? geminiUsage(j.usageMetadata) : null;
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

// grokModel: the Grok tier for this call (default Standard). Only the Test Lab avatar_sheet_variant stage passes another.
async function styleTransferGenerate(prompt, pass1ImageData, backendOverride = null, styleAnchor = null, grokModel = GROK_MODELS.STANDARD) {
  const backend = backendOverride || MODEL_DEFAULTS.avatarStyleTransferBackend;
  const aspectRatio = await aspectPresetFor(pass1ImageData); // aspect follows the sheet, not the anchor
  // Image 1 = the sheet to repaint; Image 2 (when present) = the style anchor
  // referenced by buildStyleTransferPrompt ("Image 2 is a reference of that art style").
  const refs = styleAnchor ? [pass1ImageData, styleAnchor] : [pass1ImageData];
  if (backend === 'gemini') {
    const r = await editWithGeminiImage(prompt, refs, { aspectRatio, model: MODEL_DEFAULTS.avatarStyleTransferModel });
    return { ...r, provider: 'gemini_image' };
  }
  // skipOutputCrop: the sheet is a panel GRID that gets split into cells. A
  // drift crop trims whole rows/columns off the edges — i.e. it eats panels.
  // stackRowsInto2x4 / the splitter already tolerate a drifted aspect.
  const r = await editWithGrok(prompt, refs, { aspectRatio, model: grokModel, skipOutputCrop: true });
  return { ...r, provider: 'grok' };
}

// Best-of-N cap: first attempt + N retries. The loop short-circuits on the
// first valid eval — retries only fire when an attempt fails. If all attempts
// fail, we pick the best and ship it. Two retries = up to 3 Grok calls per pass.
// Max 1 retry per stage (user direction 2026-08-09). Pass 1 (body/head rows)
// hardcodes ≤2 tries each inside generateComposited2x4; this governs Pass 2
// (style transfer) → 1 + 1 = 2 attempts.
const MAX_SHEET_RETRIES = 1;

// Pass-1 tries per row (body row, head row): the first attempt plus one retry.
// The trial prewarm passes 1 (decisions 2026-10-08, "Trial avatar sheet").
const PASS1_ROW_TRIES = 2;

// The cell-4 / cell-8 pose, ONE definition. The live row generators
// (buildBodyRowPrompt, buildHeadRowPrompt) and every sheet judge fill it from
// here: until 2026-09-23 the generators asked for a rear turn while three of the
// four judges were told the cell is a plain "back" view and the style judge that
// "cell 8 needs no face", so a flat back or a second profile passed every gate.
const REAR_TURN_POSE = 'shoulders and body fully away from camera, head rotated back over the right shoulder toward camera so one eye and the near cheek are visible';

// The styled sheet's ground, ONE definition: the pass-2 prompt states it and the
// pass-2 style judge scores it (filled into its template as {SHEET_GROUND}).
// Until 2026-09-23 neither did: 6/6 styled sheets of staging
// job_1790100385959_1nitlympp came back with painted washes and ground shadows
// behind the figures and the cell dividers gone, and every judge passed them.
// A wash rides into each page as part of the character's reference cell.
const SHEET_GROUND_RULE = "The ground stays plain white paper and the thin cell dividers stay: nothing is painted behind or around a figure — no wash, shape, scenery or cast shadow.";

// Garment colours across the style transfer, ONE definition: the pass-2 prompt
// states it about Image 1 (the pass-1 sheet) and the pass-2 style judge scores
// it about Image 2 (the same sheet, filled into its template as {GARMENT_COLOUR}).
// Until 2026-10-04 the restyler protected only hair and skin and the judge was
// told the outfit is not scored: staging job_1791040103540_atbttop6w drew a
// purple jacket on pass 1 and pass 2 repainted it navy, unchecked.
// Lettering on the sheet, ONE definition: every sheet generator states it and
// every sheet judge that checks marks scores it ({SHEET_LETTERING}). Staging
// job_1791040103540_atbttop6w: Max's body row printed the cell names from the
// prompt ("FRONT / THREE-QUARTER / PROFILE / REAR TURN") above and below every
// figure; pass 2 kept them; no judge looked for text off the character's head.
// A label that names a cell or a view ("Front", "Profile") is a caption like any other: the 2026-10-07
// showcase (job_1791315635053_t0t8qpebu) printed them under the head row of Daniel's sheet and the
// body judge excused them as "part of the reference sheet structure".
// Empty hands, on every sheet prompt (docs/decisions.md 2026-10-10). A reference photo that shows the child holding a hoop,
// a toy or a bag (or wearing a backpack) came out of the body row holding it; a sheet is an identity anchor, and every page
// is drawn from its cells. The one wording lives here so the body row, head row, style transfer and the avatar-main-prompt
// template cannot drift. An item the COSTUME names is part of the outfit and stays.
const SHEET_EMPTY_HANDS_RULE = 'Empty hands: nothing is held or carried in any cell, and no bag or backpack is worn — drop any ring, hoop, ball, toy, bag, backpack, phone or tool that a reference photo shows, with the arms relaxed at the sides; only an item the costume text names stays.';
// The head row's crop never reaches the hands, so its half of the rule is the one the crop can break: a strap.
const SHEET_HEAD_SAME_CLOTHES_RULE = 'Where the neckline shows, it is the one Image 3 wears. The clothing at the neck and shoulders is EXACTLY what Image 3 wears: the same garments, colours, collar or hood, straps, emblem and print, nothing added, nothing dropped and no other garment drawn (no bib, straps or layer that Image 3 does not wear); no bag or backpack strap.';
const SHEET_NO_LETTERING_RULE = 'The sheet is pictures only: the paper around every figure stays blank, with no caption, label, word, letter or number in or between the cells. A label naming a cell or a view (front, profile, …) is a caption too.';
// Row generators name the cells (front, three-quarter, …); those names are
// what the model printed. Generator-only: judges never see the cell names.
// A figure whose lower body is a tail or fin, ONE definition: the body-row generator states it and
// the bodies judge scores it (filled as {TAIL_POSE}). Staging job_1791315635053_t0t8qpebu: Emma's
// costumed mermaid sheet stood upright on a flat fin, and pages 8 and 10 drew her standing on her
// fin on a hard floor.
const TAIL_POSE_RULE = 'A figure whose lower body is a tail or fin never stands on it: the figure sits on the ground with the torso upright, the tail curved out along the ground in a gentle S and the fin lying flat on the ground beside it, never balanced upright on the fin like a pair of feet.';

const CELL_NAMES_NOT_DRAWN = 'The cell names here say which way each figure faces; they are never written on the sheet.';

const garmentColourRule = (sheet) => `Every garment keeps the colour ${sheet} shows it in: the same hue, with only the new medium's shading on it.`;

/**
 * A GARMENT TAKEN OFF IS GONE FROM EVERY CELL (2026-10-04). One rule for the
 * redress generator (buildRedressPrompt) and its judge (checkGarmentGone fills
 * GARMENT_PARTS into its own question): the off-garment sheet exists so a page
 * that takes a garment off is drawn from a reference without it.
 */
const GARMENT_PARTS = 'sleeve, collar, hem, hood, zip or strap';
const GARMENT_OFF_SHEET_RULE = `No cell shows any part of a garment taken off — no ${GARMENT_PARTS} of it, worn or held; the garment it leaves outermost is drawn in its place.`;

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
// A character declared to wear glasses wears them in every cell that shows the face. Left
// unstated, the sheet model kept them in the profile and body cells and dropped them in the
// front head cells of Sarah's sheet (staging job_1791267520938_essbvehs8), and every page's
// face repair copies the front cell. The sheet judges check the same fact (REQUESTED_GLASSES).
// Nothing is said for a character without glasses: the face photo decides that alone.
function buildGlassesBlock(character) {
  const g = declaredGlasses(character);
  return g ? `\nGlasses: ${g} — worn on the face in EVERY cell that shows the face, front and three-quarter included, the same frame in all, never taken off.\n` : '';
}

// The hair the character is DECLARED to have, as one sentence, or ''. ONE source for the sheet
// generators (buildHairBlock states it) and every sheet judge ({REQUESTED_HAIR}): until 2026-10-07
// the judges were never told it, so a styled sheet whose body cells had another person's hair
// (staging job_1791315635053_t0t8qpebu, Sarah), one whose hair turned from blonde to brown (Noah)
// and one that mixed hair down with a ponytail (Emma) all passed at 9-10.
function hairRequest(character) {
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
    const parting = require('./promptBuilders').partingWord(h.parting); // side never named, see partingWord
    if (parting) detail.push(parting);
    if (detail.length) hairBits.push(`Hairstyle: ${detail.join(', ')}.`);
  } else if (typeof p.detailedHairAnalysis === 'string' && p.detailedHairAnalysis.trim()) {
    hairBits.push(`Hairstyle: ${p.detailedHairAnalysis.trim()}.`);
  }
  return hairBits.join(' ');
}

function buildHairBlock(character) {
  const hair = hairRequest(character);
  if (!hair) return '';
  return `\n${hair} Reproduce the hair EXACTLY in every cell — same length, same color, same shape, same parting, worn up or down the same way. The rear-turn cell (cell 4) must show the same hair, head rotated back toward camera to reveal one eye and cheek. Do NOT invent a different cut or a different face.\n`;
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
// mannequins — used for the body row).
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

// Footwear is part of the outfit, and nothing upstream guarantees it is named.
// A trial character's `standard` entry carries no outfit text at all (the body
// photo IS the reference), so the sheet prompt was the only thing standing
// between "the reference shows shoes" and a barefoot figure — and every mention
// of shoes in these prompts was a FRAMING rule ("both feet with shoes are
// visible inside the cell"), which a barefoot figure satisfies. The sheet then
// becomes the styled avatar and the per-page reference cell, so one barefoot
// sheet renders a whole book barefoot (staging job_1789296188291_thezv15y1: the
// body reference wore trainers, the sheet dropped them, all pages and both
// covers followed). Stated once here, used by every sheet generation prompt.
//
// `seasonFootwear` (from season.js `seasonOutfitGuidance().footwear`) replaces
// the carry-over source on a seasonal sheet: the reference photo's sandals are
// exactly what a winter sheet must not copy. Absent it the rule is byte-identical
// to the shipped one, so the non-seasonal paths are untouched.
function buildFootwearRule(redress = false, seasonFootwear = null) {
  const source = redress
    ? 'Footwear is part of the costume: every cell wears what the costume names on the feet, or plain everyday shoes suiting it when the costume names none — never the footwear in the body reference, which is the wrong outfit.'
    : seasonFootwear
      ? `Footwear is part of the outfit: every cell wears ${seasonFootwear} — the footwear the body reference shows when it is already of that kind, otherwise footwear of that kind in a colour that suits the outfit.`
      : 'Footwear is part of the outfit: every cell wears the footwear the body reference shows, same type and colour, or plain everyday shoes suiting the outfit when neither the reference nor the outfit shows any.';
  return `${source} Bare feet only when the outfit names them, or when the lower body is a tail, fin, or single fused form with no feet at all.`;
}

// A garment named with its PARTS is still one garment. The story bible spells
// structural parts out ("... — square bib panel over the chest held by two
// shoulder straps — ...") because a garment named alone renders as a plain one;
// but a parts list invites a parts ASSEMBLY — straps laid over a separate pair
// of trousers — and the two rows are generated separately, so each row picks its
// own reading. One clause owns both halves: the parts are cut in one, and both
// rows show that same garment. Generic by design — no story nouns.
function buildGarmentRule() {
  return 'A garment named with its parts is ONE continuous piece, not separate items worn together: a bib-and-brace garment has its bib panel and shoulder straps cut in one with its trousers, same fabric and same colour, never straps laid over a separate pair of trousers. Every named part is present in every cell whose crop reaches it, and both rows of the sheet show that same garment.';
}

// No invented neckline detail. The heads judge scores "a collar, placket, hood
// or trim the outfit does not name" 1-3, and until 2026-09-23 only the dead
// single-call builder carried the matching instruction: the live rows never got
// it, and a plain "long-sleeve shirt" came back as a buttoned polo on both
// sheets of two characters (staging job_1790100385959_1nitlympp). On a redress
// sheet the costume text is the whole outfit; otherwise the body reference is
// part of the outfit too, so what it shows is not an invention.
function buildUnnamedTrimRule(redress = false) {
  return redress
    ? 'No collar, placket, hood or trim the costume does not name.'
    : 'No collar, placket, hood or trim that neither the costume nor the body reference shows.';
}

// The season reaches the sheet as an OUTFIT instruction and nothing else. The
// sheet is the identity anchor: the season may change what the figure wears,
// never who the figure is — so the block names the garments and then pins face,
// hair, skin tone, build and apparent age to the references.
//
// Suppressed on a redress sheet: there the costume IS the outfit and owns it
// whole (a pirate does not gain a parka in December). Suppressed when no
// guidance is passed, which is every non-seasonal caller.
function buildSeasonOutfitBlock(seasonOutfit = null, redress = false) {
  if (!seasonOutfit?.outfit || redress) return '';
  const label = seasonOutfit.label || '';
  return `\nSeason: ${label}. The figure is dressed for ${label.toLowerCase()} outdoors in a temperate climate: ${seasonOutfit.outfit}. Adapt the GARMENTS only, keeping the reference's own colours and character wherever the season allows them — face, hair, hairstyle, skin tone, build and apparent age are exactly as the references show and never change. The same outfit appears in every cell.`;
}

// Body-row prompt (call 1): one row of 4 full bodies, tall cells. Keeps the
// outer layer in the profile (validated wording). Generic — no story specifics.
// styleLine (Test Lab avatar_sheet_variant 'styledBodyRow' only): draw the row in the story's art style instead of the realistic
// identity-anchor look. Null = the production prompt, byte for byte.
function buildBodyRowPrompt(costumeDescription, character = null, redress = false, costumeName = null, seasonOutfit = null, styleLine = null) {
  const hairBlock = buildHairBlock(character);
  const bodyRef = redress
    ? `Image 2 shows the character's body shape, build, and identity ONLY — IGNORE the clothing in Image 2, it is the wrong outfit. Image 3 is the character's face.`
    : `Image 2 is the character's body: take its CLOTHING ONLY. Whatever the person holds or carries in Image 2 — a hoop, ball or toy in the hands, a backpack or bag on the back or shoulders — is NOT part of the character: the hands are empty and the back and shoulders are bare, with no strap anywhere. Image 3 is the character's face.`;
  // The costume NAME, not just its garments. Without it the model gets a bare
  // garment list and renders each item by its most common association — a cloth
  // head wrap on a small child reads as a headband bow, not as pirate headwear.
  const named = costumeName ? ` — a ${costumeName}` : '';
  const outfitRule = redress
    ? `Costume${named} (the ONLY outfit — every cell wears exactly this, NOT the clothing from Image 2): ${costumeDescription}`
    : `Costume${named}: ${costumeDescription}`;
  const readsAs = costumeName ? `
The figure reads as a ${costumeName} at a glance. Each garment is worn the way that costume wears it.` : '';
  // Age has ONE source. When the declared age is known, declaredAgeBlock owns
  // proportions outright and the "apparent age in Image 3" clauses are dropped —
  // two contradictory instructions in one prompt ("match the photo" vs "the
  // stated age outranks the photo") let the model pick, and it picks the photo.
  const declaredAge = declaredAgeBlock(character);
  const ageFromPhoto = declaredAge ? '' : " matching the person's apparent age in Image 3";
  const proportionsRule = declaredAge
    ? declaredAge.trimStart()
    : "Body proportions match the person's apparent age (an adult is roughly 7 to 8 heads tall).";
  return `Image 1 indicates only the camera angle and facing direction in each cell — ignore its silhouette, body, and face. The output contains no arrows.
${bodyRef}

${outfitRule}${readsAs}${buildSeasonOutfitBlock(seasonOutfit, redress)}${hairBlock}${buildGlassesBlock(character)}
${styleLine
    ? `Render every cell in this art style: ${styleLine}. The face, hair colour and skin tone stay recognisably the person in Image 3; natural proportions${ageFromPhoto}. ${SHEET_GROUND_RULE} This sheet is an identity anchor.`
    : `Render every cell as a REALISTIC reference — the same visual style as the source face photo in Image 3. Photographic / lifelike, natural proportions${ageFromPhoto}. No cartoon, no anime, no watercolour. This sheet is an identity anchor.`}

Output a 1×4 grid: ONE row, four cells side by side, thin black vertical dividers, pure white background, same cell layout as Image 1.
Each cell shows the SAME PERSON as Image 3 rendered as a COMPLETE FULL BODY from the very top of the head to the figure's lowest point, wearing the costume. Cell 1 front, cell 2 three-quarter, cell 3 profile, cell 4 is a REAR TURN: ${REAR_TURN_POSE}. Cell 4 is never a profile and never a flat back view with no face showing — Image 1's cell 4 is a plain reference silhouette only, ignore its exact head angle. Normally that lowest point is both feet with shoes, and the whole figure — head, hair, face, torso, legs, feet — sits inside its cell. When the costume replaces the legs (a tail, a fin, a single fused lower body), the figure has NO legs, NO feet and NO footwear: it ends at the tip of that form, which is then the lowest point. ${TAIL_POSE_RULE} Image 1's standing silhouette applies to the head and torso only. Never crop the head and never crop the lowest point; if the figure does not fit, scale it down until the whole figure is inside the cell, with white margin above and below. ${proportionsRule}
${buildFootwearRule(redress, seasonOutfit?.footwear)}
${buildGarmentRule()}
${SHEET_EMPTY_HANDS_RULE}
The outfit is identical in all four cells, layers included. ${buildUnnamedTrimRule(redress)} When the costume has an outer layer — vest, jacket, cardigan, coat, or overshirt — it stays on in the profile and back cells. Seen edge-on in the profile, its front opening runs as a vertical band down the side of the torso, with the shoulder seam, armhole, and the back panel visible behind the arm. No arrows or symbols anywhere. ${SHEET_NO_LETTERING_RULE} ${CELL_NAMES_NOT_DRAWN}`;
}

// Head-row prompt (call 2): one row of 4 head-shots that match the body sheet.
// Refs: Image 1 = mannequin head row (angles), Image 2 = face photo (identity),
// Image 3 = the body row from call 1 (match its rendered face/hair).
// The head row is ALWAYS drawn against the body row (Image 3): head and body wear the same clothes (docs/decisions.md 2026-10-10,
// which replaced the 2026-10-08 parallel rows).
function buildHeadRowPrompt(character = null, costumeDescription = '', redress = false, styleLine = null) {
  const hairBlock = buildHairBlock(character);
  // The costume text reaches this call at all only since the dungaree fault
  // (2026-09-14): the row was generated from the body IMAGE alone, so a part
  // that the body row rendered ambiguously — a bib panel and its straps — was
  // simply dropped here, and the two rows disagreed about the garment.
  const outfitLine = costumeDescription ? `
Costume: ${costumeDescription} — the same garment the body sheet wears. Every part of it that the head-and-shoulders crop reaches, straps and neckline included, is drawn.` : '';
  return `Image 1 shows the four camera angles for a head-shot row — use it ONLY for facing direction; ignore its face and features, and never draw arrows.
Image 2 is the character's face photo — the identity; match this exact face.
Image 3 is the character's full-body reference sheet — match the SAME face, hair colour, hairstyle, and skin tone shown there so the heads belong to that body.${outfitLine}
${buildGarmentRule()} ${SHEET_HEAD_SAME_CLOTHES_RULE} ${SHEET_EMPTY_HANDS_RULE} ${buildUnnamedTrimRule(redress)}${hairBlock}${buildGlassesBlock(character)}
Output a 1×4 grid: ONE row, four cells side by side, thin black vertical dividers, pure white background. Each cell is framed like a passport photo of the SAME PERSON: head, neck and the top of the shoulders wearing the costume, cut off at the upper chest, with plain white above the hair and filling the rest of the cell; no bare skin below the neck. No waist, hands or lower body in any cell. Never crop the top of the head. Cell 1 front, cell 2 three-quarter, cell 3 profile.
Cell 4 is a REAR TURN, distinct from cell 3's profile: ${REAR_TURN_POSE}. Cell 4 is never a second profile and never a flat back of the head with no face showing — Image 1's cell 4 is a plain placeholder silhouette, ignore its exact head angle entirely.
${styleLine ? `Art style: ${styleLine}, the same as Image 3; ${SHEET_GROUND_RULE}` : 'Photographic / lifelike;'} identity from Image 2; hair, skin tone, and costume consistent with Image 3.${declaredAgeBlock(character)} No arrows or symbols. ${SHEET_NO_LETTERING_RULE} ${CELL_NAMES_NOT_DRAWN}`;
}

// Pure: the pixels of headroom to add on top of the head row so the sheet stack lands exactly on an aspect preset the
// style transfer takes without cropping. A stack at least as wide as it is tall is padded up to the largest preset
// width:height ratio that does not exceed it (1:1, 4:3, 16:9 — the ones the stack reaches by gaining height); a taller
// stack is left alone (the pre-crop stack was ~1:1 within 2%).
function sheetStackPad(width, height) {
  const r = width / height;
  if (!(r > 1)) return 0;
  const ratio = [16 / 9, 4 / 3, 1].find(p => p <= r + 1e-9);
  return Math.max(0, Math.round(width / ratio) - height);
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
  // THE STACK IS BUILT TO AN EXACT PRESET (2026-10-08, Fiona rerun job_1791450210539_nwi88y9lr, Saira: the crown of her
  // head was cut in all four styled head cells). cropHeadRowToShoulders (2026-10-07) shortens the head row from 576 to ~330
  // px, so the stack is 1280x1060 = 1.21: the nearest preset is 4:3, and editWithGrok coerces its input to the preset by
  // CROPPING the longer axis (fit:cover) — about 5% off the top and the bottom, and the generator leaves only ~4% headroom
  // above the hair. The extra height goes on top of the head row instead (sheetStackPad), so the coercion crops nothing.
  const pad = sheetStackPad(W, hMeta.height + SEAM + bMeta.height);
  const headTop = pad > 0
    ? await sharp(headResized).extend({ top: pad, extendWith: 'copy' }).toBuffer()
    : headResized;
  const headH = hMeta.height + pad;
  const H = headH + SEAM + bMeta.height;
  const splitY = headH + Math.round(SEAM / 2);
  const out = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([
      { input: headTop, top: 0, left: 0 },
      { input: bodyBuf, top: headH + SEAM, left: 0 },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
  return { imageData: `data:image/jpeg;base64,${out.toString('base64')}`, splitY };
}

// ── Head-row crop (2026-10-07) ────────────────────────────────────────────────
// The head row is generated at 20:9, so each of its four cells is a TALL 5:9 portrait, and the model
// fills a tall cell with a figure down to the waist or the thighs however the prompt frames it
// ("like a passport photo" did not hold: 4 of 6 head-row attempts of staging showcase
// job_1791315635053_t0t8qpebu failed the crop judge, two shipped failing; docs/decisions.md 2026-09-23
// recorded the same fault and that wording fix). So the framing is made mechanically: the analyzer's
// pose model finds the nose and the shoulders in every cell, and the row is cut a fixed fraction of
// the nose-to-shoulder distance below the shoulders — head, neck and the top of the chest. The
// crop judge still scores the result.
const HEAD_CROP_BELOW_SHOULDER = 0.5;

// Pure: the row fraction (0-1) to keep from the top, or null when fewer than 2 cells carry both keypoints.
function headRowCropFraction(cells) {
  const usable = (Array.isArray(cells) ? cells : []).filter(c => Number.isFinite(c?.nose_y_frac) && Number.isFinite(c?.shoulder_y_frac) && c.shoulder_y_frac > c.nose_y_frac);
  if (usable.length < 2) return null;
  return Math.min(1, Math.max(...usable.map(c => c.shoulder_y_frac + HEAD_CROP_BELOW_SHOULDER * (c.shoulder_y_frac - c.nose_y_frac))));
}

// Returns { imageData, crop } — crop.applied false (with a reason) leaves the row as generated.
async function cropHeadRowToShoulders(headRowData) {
  const keep = (reason) => ({ imageData: headRowData, crop: { applied: false, reason } });
  let cells;
  try {
    const j = await analyzerJson('/pose-heads', { image: headRowData, cols: 4 }, { timeoutMs: 60_000 });
    if (!Array.isArray(j.cells)) throw new AnalyzerError('/pose-heads', `answered without cells: ${JSON.stringify(j).slice(0, 120)}`);
    cells = j.cells;
  } catch (err) {
    reportAnalyzerFailure('[CHARACTER 2×4] /pose-heads — the head row stays uncropped (the crop judge still scores it)', err);
    return keep(`analyzer unavailable: ${err.message}`);
  }
  if (cells.length && cells.every(c => !('shoulder_y_frac' in c))) {
    log.error('[CHARACTER 2×4] /pose-heads answered without shoulder keypoints — the analyzer predates the head-row crop; the head row stays uncropped');
    return keep('analyzer predates shoulder keypoints');
  }
  const frac = headRowCropFraction(cells);
  if (frac == null) {
    log.warn('[CHARACTER 2×4] head-row crop: fewer than 2 cells with nose and shoulders found — the head row stays uncropped');
    return keep('fewer than 2 cells with nose and shoulders');
  }
  const buf = Buffer.from(r2.stripDataUriPrefix(headRowData), 'base64');
  const { width, height } = await sharp(buf).metadata();
  const cutY = Math.round(frac * height);
  if (cutY >= height * 0.97) return keep('already framed at the chest');
  const out = await sharp(buf).extract({ left: 0, top: 0, width, height: cutY }).jpeg({ quality: 92 }).toBuffer();
  return { imageData: `data:image/jpeg;base64,${out.toString('base64')}`, crop: { applied: true, fromHeight: height, toHeight: cutY, fraction: Math.round(frac * 1000) / 1000 } };
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
    bodies.solo?.soloScore ?? 10,
    bodies.background?.backgroundScore ?? 10,
    bodies.glasses?.glassesScore ?? 10,
    bodies.hair?.hairScore ?? 10,
    bodies.person?.personScore ?? 10,
  );
  bodies.valid = bodies.finalScore >= 6;
  if (fb.fullBodyScore <= 2) bodies.failureReasons = [...(bodies.failureReasons || []), `fullBody: ${headReason}`];
  return bodies;
}

// Review the 1×4 body row on its own (it IS the bottom-body crop the eval wants,
// so no split needed): pose head-check + Gemini bodies eval, merged by the gate.
async function reviewBodyRow(bodyRowData, { costumeDescription, costumeName = null, model, usageTracker, declaredAge = null, glasses = null, hair = null }) {
  const [poseHeads, bodiesR] = await Promise.all([
    detectBodyRowHeads(bodyRowData),
    evaluateSheetRow(bodyRowData, 'bodies', { costumeDescription, costumeName, model, usageTracker, declaredAge, glasses, hair }),
  ]);
  const bodies = applyPoseHeadGate(bodiesR.report, poseHeads);
  return { valid: !!bodies.valid, score: bodies.finalScore ?? 0, bodies, promptUsed: bodiesR.promptUsed };
}

// Review the 1×4 head row: heads-structure eval + identity vs face photo/avatar.
async function reviewHeadRow(headRowData, { facePhoto, avatarFaces, model, usageTracker, declaredAge = null, costumeDescription = '', glasses = null, hair = null }) {
  const hasRefs = !!(facePhoto || avatarFaces);
  const [headsR, identityR] = await Promise.all([
    evaluateSheetRow(headRowData, 'heads', { costumeDescription, model, usageTracker, glasses, hair }),
    hasRefs ? evaluateIdentity(headRowData, { sourcePhoto: facePhoto, avatarFaces, model, usageTracker, declaredAge }) : Promise.resolve(null),
  ]);
  const heads = headsR.report;
  const identity = identityR?.report || null;
  const idScore = identity?.identityScore ?? 10;
  const score = Math.min(heads?.finalScore ?? 0, idScore);
  return { valid: score >= 6, score, heads, identity, promptUsed: headsR.promptUsed, identityPromptUsed: identityR?.promptUsed || null };
}

// Stage 1 of the decoupled sheet: the 1×4 FULL-BODY row (up to rowTries tries, keep least-bad). Its own render, before and
// independent of the head row, so a caller can draw it ahead of the rest (generateBodyRow) and hand it back to
// generateComposited2x4 as `precomputedBody` (docs/decisions.md 2026-10-09, trial body row at the photo).
// deferReview (one try only, see generateComposited2x4): the judge runs in the background and its promise rides on the result, so the
// caller can start the next render while it works. The attempt entry is filled in when the judge answers.
async function runBodyRowStage({ character, bodyPrompt, bodyRefs, rowTries, skipReview, costumeDescription, costumeName, model, usageTracker, attemptHistory, addUsage, deferReview = false, grokModel = GROK_MODELS.STANDARD }) {
  // ── Stage 1: body row (up to rowTries tries, keep least-bad) ──
  let bestBody = null;
  let bodyGenError = null;
  for (let t = 1; t <= rowTries; t++) {
    // skipOutputCrop — see styleTransferGenerate: cropping a 16:9 row back to
    // 16:9 from a squarer output would slice the figures' heads/feet off.
    // A THROWN backend call consumes ONE try — it must never escape this loop.
    // The 120s AbortSignal timeout in editWithGrok used to propagate straight
    // out of generateComposited2x4, killing the whole sheet on try 1 and
    // leaving the provisioned retry unused (measured: staging runs
    // job_1789337998754_apslnsq1z / job_1789343124794_z2c779f7i, "The
    // operation was aborted due to timeout"). Same containment Pass 2 already
    // has (stage 'gen-error'); the eval calls below are wrapped for the same
    // reason. If BOTH tries throw, the sheet still fails loudly at the throw
    // after the loop, carrying the last provider error.
    let res;
    try {
      res = await editWithGrok(bodyPrompt, bodyRefs, { aspectRatio: '16:9', model: grokModel, skipOutputCrop: true });
    } catch (err) {
      bodyGenError = err?.message || String(err);
      attemptHistory.push({ stage: 'body', try: t, error: `gen-error: ${bodyGenError}` });
      log.warn(`[CHARACTER 2×4] ${character?.name} body try ${t}/${rowTries} threw: ${bodyGenError}${t < rowTries ? ' — retrying' : ''}`);
      continue;
    }
    if (!res?.imageData) { attemptHistory.push({ stage: 'body', try: t, error: 'no image' }); continue; }
    addUsage(res.usage, 'character_2x4_body_row', res.modelId);
    // A SKIPPED review is UNKNOWN, never a 10 (staging job_1788763045123_z8so79ngb:
    // a sheet with three strangers merged across its cells was stored at 10/10 on
    // every axis without a single judge call). score null = unscored; valid stays
    // true so the sheet still ships (the caller asked for no reviews).
    let review = { valid: true, score: null, evaluated: false, bodies: null };
    let reviewPromise = null;
    const judge = async () => {
      try {
        return await reviewBodyRow(res.imageData, { costumeDescription, costumeName, model, usageTracker, declaredAge: character?.age, glasses: declaredGlasses(character), hair: hairRequest(character) });
      } catch (err) {
        // Keep the sheet. Losing the eval costs a quality gate; losing the
        // sheet costs the character its face on every page of the book, which
        // is strictly worse. Loud, and visible in attemptHistory.
        log.error(`[CHARACTER 2×4] ${character?.name} body eval FAILED (${err.message}) — keeping the unscored sheet`);
        return { valid: true, score: 0, bodies: null, evalFailed: err.message };
      }
    };
    if (!skipReview) { if (deferReview) reviewPromise = judge(); else review = await judge(); }
    const entry = { stage: 'body', try: t, score: review.score, valid: review.valid, reasons: review.bodies?.failureReasons || [] };
    attemptHistory.push(entry);
    if (reviewPromise) reviewPromise.then(r => Object.assign(entry, { score: r.score, valid: r.valid, reasons: r.bodies?.failureReasons || [] }));
    const rank = (v) => (typeof v === 'number' ? v : -1); // unscored ranks below any judged attempt
    if (!bestBody || rank(review.score) > rank(bestBody.review.score)) bestBody = { row: res.imageData, review, reviewPromise };
    if (review.valid) break;
    log.warn(`[CHARACTER 2×4] ${character?.name} body try ${t} invalid (score=${review.score}) — ${skipReview ? '' : (review.bodies?.failureReasons || []).join('; ')}`);
  }
  if (!bestBody) throw new Error(`[CHARACTER 2×4] body row produced no image for ${character?.name}${bodyGenError ? ` (last provider error: ${bodyGenError})` : ''}`);
  return bestBody;
}

// Two-call generation → one composited 2×4 sheet, WITH review between the calls.
// (1) body row, reviewed (pose + bodies eval); up to rowTries tries (default 2), keep least-bad.
// (2) head row on the ACCEPTED body, reviewed (heads + identity); same tries,
// keep least-bad. rowTries 1 is the trial prewarm (fastPass1). Then composite. Rejected rows are discarded. Returns a verdict
// in the evaluateSheetSplit shape so generateCharacter2x4Sheet / styledAvatars
// consume it unchanged. skipReview → 1 try each, no eval (fast path for tests).
// deferJudges (honoured only with one try per row and reviews on, the trial prewarm): with one try nothing can act on a row verdict, so
// the judges only record. The body judge then runs while the head row renders, the head and identity judges while the caller styles the
// sheet, and the verdict arrives as `verdictPromise` (never rejects) instead of `verdict`. docs/decisions.md 2026-10-10.
async function generateComposited2x4(character, { costumeDescription, costumeName = null, redress = false, usageTracker = null, skipReview = false, seasonOutfit = null, rowTries = PASS1_ROW_TRIES, precomputedBody = null, deferJudges = false, grokModel = GROK_MODELS.STANDARD, styleLine = null } = {}) {
  const facePhoto = await resolveFacePhoto(character);
  if (!facePhoto) throw new Error(`No face photo for ${character?.name || 'character'}.`);
  const standardAvatar = await resolveStandardAvatar(character);
  const avatarFaces = standardAvatar ? (await splitSheetRows(standardAvatar)).topHeads : null;
  const bodyPhantom = await phantomRow(loadPhantomVariant(character?.age, 'plain'), 'bottom');
  const headPhantom = await phantomRow(loadPhantomVariant(character?.age, 'axes'), 'top');
  const model = MODEL_DEFAULTS.sheetEvalModel;
  const bodyRefs = standardAvatar ? [bodyPhantom, standardAvatar, facePhoto] : [bodyPhantom, facePhoto];
  const bodyPrompt = buildBodyRowPrompt(costumeDescription, character, redress, costumeName, seasonOutfit, styleLine);
  const headPrompt = buildHeadRowPrompt(character, costumeDescription, redress, styleLine);
  const attemptHistory = [];
  const defer = deferJudges && rowTries === 1 && !skipReview;
  let usage = { input_tokens: 0, output_tokens: 0 };
  const addUsage = (u, fn, id) => { if (u) { usage.input_tokens += u.input_tokens || 0; usage.output_tokens += u.output_tokens || 0; if (usageTracker) usageTracker('grok', u, fn, id); } };

  if (precomputedBody?.attemptHistory) attemptHistory.push(...precomputedBody.attemptHistory);
  const runBodyRow = async () => precomputedBody || runBodyRowStage({ character, bodyPrompt, bodyRefs, rowTries, skipReview, costumeDescription, costumeName, model, usageTracker, attemptHistory, addUsage, deferReview: defer, grokModel });

  const runHeadRow = async (bodyRow) => {
    // ── Stage 2: head row (up to rowTries tries, keep least-bad) ──
    // Head row uses 20:9 — the widest/shortest ratio in Grok's aspect enum
    // (16:3 is not allowed). Stacked under the 16:9 body row the composite is
    // ~1:1 (720 + 576 ≈ 1280 tall), a native preset for the Pass-2 style call, so
    // no padding/squeeze; full-width, no side margins. See stackRowsInto2x4.
    const headRefs = [headPhantom, facePhoto, bodyRow];
    let bestHead = null;
    let headGenError = null;
    for (let t = 1; t <= rowTries; t++) {
      // skipOutputCrop — 20:9 is the extreme end of Grok's enum and drift is
      // common; cropping a near-square output down to 20:9 would decapitate the
      // head row. stackRowsInto2x4 resizes by width and keeps the full row.
      // A thrown backend call consumes ONE try — see the body row above.
      let res;
      try {
        res = await editWithGrok(headPrompt, headRefs, { aspectRatio: '20:9', model: grokModel, skipOutputCrop: true });
      } catch (err) {
        headGenError = err?.message || String(err);
        attemptHistory.push({ stage: 'head', try: t, error: `gen-error: ${headGenError}` });
        log.warn(`[CHARACTER 2×4] ${character?.name} head try ${t}/${rowTries} threw: ${headGenError}${t < rowTries ? ' — retrying' : ''}`);
        continue;
      }
      if (!res?.imageData) { attemptHistory.push({ stage: 'head', try: t, error: 'no image' }); continue; }
      addUsage(res.usage, 'character_2x4_head_row', res.modelId);
      const headCrop = await cropHeadRowToShoulders(res.imageData);
      res = { ...res, imageData: headCrop.imageData };
      let review = { valid: true, score: null, evaluated: false, heads: null, identity: null };
      let reviewPromise = null;
      const judge = async () => {
        try {
          return await reviewHeadRow(res.imageData, { facePhoto, avatarFaces, model, usageTracker, declaredAge: character?.age, costumeDescription, glasses: declaredGlasses(character), hair: hairRequest(character) });
        } catch (err) {
          log.error(`[CHARACTER 2×4] ${character?.name} head eval FAILED (${err.message}) — keeping the unscored row`);
          return { valid: true, score: 0, heads: null, identity: null, evalFailed: err.message };
        }
      };
      if (!skipReview) { if (defer) reviewPromise = judge(); else review = await judge(); }
      const entry = { stage: 'head', try: t, score: review.score, valid: review.valid, reasons: review.heads?.failureReasons || [], crop: headCrop.crop };
      attemptHistory.push(entry);
      if (reviewPromise) reviewPromise.then(r => Object.assign(entry, { score: r.score, valid: r.valid, reasons: r.heads?.failureReasons || [] }));
      const rank = (v) => (typeof v === 'number' ? v : -1); // unscored ranks below any judged attempt
      if (!bestHead || rank(review.score) > rank(bestHead.review.score)) bestHead = { row: res.imageData, review, reviewPromise };
      if (review.valid) break;
      log.warn(`[CHARACTER 2×4] ${character?.name} head try ${t} invalid (score=${review.score})`);
    }
    if (!bestHead) throw new Error(`[CHARACTER 2×4] head row produced no image for ${character?.name}${headGenError ? ` (last provider error: ${headGenError})` : ''}`);
    return bestHead;
  };

  // The head row is drawn against the ACCEPTED body row (decisions 2026-08-09), so the heads belong to that body and wear its
  // clothes. The 2026-10-08 parallel mode (head row without the body) is gone: costumed head and body differed in emblem and
  // collar (docs/decisions.md 2026-10-10).
  const bestBody = await runBodyRow();
  const bestHead = await runHeadRow(bestBody.row);

  // ── Composite + build the evaluateSheetSplit-shape verdict from the reviews ──
  const { imageData, splitY } = await stackRowsInto2x4(bestHead.row, bestBody.row);
  const settle = ([bodyReview, headReview]) => {
    const bodies = bodyReview.bodies;
    const heads = headReview.heads;
    const identity = headReview.identity;
    // skipReview → nothing was judged: every axis is null (unknown), not 10.
    const sc = (v) => (skipReview ? null : v);
    const idScore = skipReview ? null : (identity?.identityScore ?? 10);
    const finalScore = skipReview ? null : Math.min(heads?.finalScore ?? 0, bodies?.finalScore ?? 0, idScore);
    // When a row judge threw, its sub-report is null and the ?? defaults below
    // read as a perfect 10. Carry the failure so consumers show "unscored", not
    // a fake pass — the sheet still ships, it just wasn't judged.
    const evalFailed = bodyReview.evalFailed || headReview.evalFailed || null;
    const verdict = {
      split: true, splitY, finalScore,
      // Unevaluated is not a failure: the sheet ships, it is simply unjudged.
      valid: skipReview ? true : finalScore >= 6,
      evaluated: !skipReview, evalSkipped: skipReview ? 'skipQualityEval' : null, evalFailed,
      failureReasons: [...(heads?.failureReasons || []), ...(bodies?.failureReasons || [])],
      layout: { layoutScore: sc(bodies?.fullBody?.fullBodyScore ?? 10) },
      identity: { identityScore: idScore, reason: identity?.reason },
      outfit: { outfitScore: sc(bodies?.outfit?.outfitScore ?? 10) },
      sourceMatch: { sourceMatchScore: idScore },
      cleanRender: { cleanScore: sc(heads?.cleanRender?.cleanScore ?? 10) },
      heads, bodies, identityReport: identity,
    };
    // What each judge of the shipped rows was sent (text only — the images are
    // the rows themselves), so a stored verdict can be read against its prompt.
    // null when nothing was judged.
    const judgePrompts = skipReview ? null : {
      bodies: bodyReview.promptUsed || null,
      heads: headReview.promptUsed || null,
      identity: headReview.identityPromptUsed || null,
    };
    return { verdict, judgePrompts };
  };
  const verdictPromise = Promise.all([bestBody.reviewPromise || bestBody.review, bestHead.reviewPromise || bestHead.review]).then(settle);
  // Not deferred: the verdict is part of the result, as ever. Deferred: the caller awaits verdictPromise when it needs the verdict.
  const settled = defer ? null : await verdictPromise;
  return {
    imageData, ...(settled || {}), verdictPromise, usage, modelId: grokModel,
    refs: { phantom: headPhantom, bodyPhantom, standardAvatar, facePhoto },
    prompt: `— BODY ROW —
${bodyPrompt}

— HEAD ROW —
${headPrompt}`,
    bodyRow: bestBody.row, headRow: bestHead.row, attemptHistory,
  };
}

// ── Test Lab only: the whole styled 2×4 sheet from the photo in ONE call (avatar_sheet_variant 'oneCall') ──────────────────────
// Built from the same rule constants and prompt blocks the two row prompts use. NOT wired into any production path: the 2026-08-08
// split into two row calls exists because one combined call gave a headless bottom row ~70% of the time (docs/decisions.md); the
// Lab stage measures whether a stronger Grok tier changes that. Layout guide = the axes phantom's head row over the plain
// phantom's body row, the two guides the production rows are drawn against.
function buildOneCallSheetPrompt(character, { costumeDescription, costumeName = null, seasonOutfit = null, styleLine }) {
  const named = costumeName ? ` — a ${costumeName}` : '';
  const declaredAge = declaredAgeBlock(character);
  const ageFromPhoto = declaredAge ? '' : " matching the person's apparent age in Image 2";
  const proportionsRule = declaredAge ? declaredAge.trimStart() : "Body proportions match the person's apparent age (an adult is roughly 7 to 8 heads tall).";
  return `Image 1 is a layout guide ONLY: a 2×4 grid (two rows of four cells) showing the camera angle and facing direction of each cell. Ignore its silhouettes, bodies and faces. The output contains no arrows.
Image 2 is the character's face photo — the identity; match this exact face.

Output ONE image: a 2×4 grid, thin dividers between the cells, pure white background, the same layout as Image 1. Every cell shows the SAME PERSON as Image 2, alone, in the same art style, wearing the same costume.
TOP ROW (4 cells): head, neck and the top of the shoulders, cut off at the upper chest, with plain white above the hair; never crop the top of the head. BOTTOM ROW (4 cells): the COMPLETE FULL BODY from the very top of the head to the figure's lowest point (normally both feet with shoes), the whole figure inside its cell; if it does not fit, scale it down with white margin above and below. ${proportionsRule}
In both rows: cell 1 front, cell 2 three-quarter, cell 3 profile, cell 4 a REAR TURN: ${REAR_TURN_POSE}. Cell 4 is never a second profile and never a flat back view with no face showing.

Costume${named}: ${costumeDescription}${buildSeasonOutfitBlock(seasonOutfit, false)}${buildHairBlock(character)}${buildGlassesBlock(character)}
Art style: ${styleLine}${ageFromPhoto ? `. Natural proportions${ageFromPhoto}` : ''}. The face, hair colour and skin tone stay recognisably the person in Image 2.
${buildFootwearRule(false, seasonOutfit?.footwear)}
${buildGarmentRule()}
${SHEET_EMPTY_HANDS_RULE}
The outfit is identical in all eight cells, layers included, and the neckline in the top row is the one the body below wears. ${buildUnnamedTrimRule(false)} ${SHEET_GROUND_RULE} ${SHEET_NO_LETTERING_RULE} ${CELL_NAMES_NOT_DRAWN}`;
}

async function generateOneCallSheet(character, { artStyle, costumeDescription = 'standard outfit', costumeName = null, seasonOutfit = null, usageTracker = null, grokModel = GROK_MODELS.STANDARD } = {}) {
  if (!artStyle || artStyle === 'realistic') throw new Error('generateOneCallSheet: a non-realistic art style is required');
  const facePhoto = await resolveFacePhoto(character);
  if (!facePhoto) throw new Error(`No face photo for ${character?.name || 'character'}.`);
  const head = Buffer.from(r2.stripDataUriPrefix(await phantomRow(loadPhantomVariant(character?.age, 'axes'), 'top')), 'base64');
  const body = Buffer.from(r2.stripDataUriPrefix(await phantomRow(loadPhantomVariant(character?.age, 'plain'), 'bottom')), 'base64');
  const W = (await sharp(body).metadata()).width;
  const headFit = await sharp(head).resize({ width: W }).png().toBuffer();
  const hH = (await sharp(headFit).metadata()).height;
  const bH = (await sharp(body).metadata()).height;
  const guide = await sharp({ create: { width: W, height: hH + bH, channels: 3, background: '#ffffff' } })
    .composite([{ input: headFit, top: 0, left: 0 }, { input: body, top: hH, left: 0 }]).png().toBuffer();
  const prompt = buildOneCallSheetPrompt(character, { costumeDescription, costumeName, seasonOutfit, styleLine: resolveStyleLineForSheet(artStyle) });
  const res = await editWithGrok(prompt, [`data:image/png;base64,${guide.toString('base64')}`, facePhoto], { aspectRatio: '1:1', model: grokModel, skipOutputCrop: true });
  if (!res?.imageData) throw new Error(`generateOneCallSheet: no image for ${character?.name}`);
  if (usageTracker && res.usage) usageTracker('grok', res.usage, 'character_2x4_one_call', res.modelId);
  return { imageData: res.imageData, usage: res.usage, modelId: res.modelId || grokModel, prompt };
}

/**
 * The 1×4 full-body row of a sheet as its OWN render (stage 1 of generateComposited2x4), drawn ahead of the rest.
 * The trial draws it the moment the photo is analysed, from the photo's age/gender estimates, so the visitor sees a
 * full-body figure while the form is still being filled; the finished sheet reuses it (`precomputedBody`) when the
 * age band and gender it was drawn for still hold. No extra paid call: the same body-row call the sheet would make.
 *
 * @returns {Promise<{ row: string, review: object, attemptHistory: object[], usage: object }>} `row` is the row image (data URI)
 */
async function generateBodyRow(character, { costumeDescription = 'standard outfit', costumeName = null, redress = false, usageTracker = null, skipReview = false, seasonOutfit = null, rowTries = PASS1_ROW_TRIES } = {}) {
  const facePhoto = await resolveFacePhoto(character);
  if (!facePhoto) throw new Error(`No face photo for ${character?.name || 'character'}.`);
  const standardAvatar = await resolveStandardAvatar(character);
  const bodyPhantom = await phantomRow(loadPhantomVariant(character?.age, 'plain'), 'bottom');
  const bodyRefs = standardAvatar ? [bodyPhantom, standardAvatar, facePhoto] : [bodyPhantom, facePhoto];
  const bodyPrompt = buildBodyRowPrompt(costumeDescription, character, redress, costumeName, seasonOutfit);
  const attemptHistory = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  const addUsage = (u, fn, id) => { if (u) { usage.input_tokens += u.input_tokens || 0; usage.output_tokens += u.output_tokens || 0; if (usageTracker) usageTracker('grok', u, fn, id); } };
  const best = await runBodyRowStage({ character, bodyPrompt, bodyRefs, rowTries, skipReview, costumeDescription, costumeName, model: MODEL_DEFAULTS.sheetEvalModel, usageTracker, attemptHistory, addUsage });
  return { row: best.row, review: best.review, attemptHistory, usage };
}

/**
 * Pass 2 on the FULL-BODY row alone: the same style transfer the sheet gets (styleTransferGenerate, the sheet's prompt worded
 * for a 1x4 row), one attempt, no judge and no anchor (nothing can act on a verdict in the trial; the anchor is only attached
 * when a judge can reject a contaminated result, see runStyleTransferPass). The trial shows the row's cells before the sheet
 * exists, so they must already be in the story's style (owner, 2026-10-10: "some avatars are not watercolour"). The row it is
 * given stays the sheet's pass-1 body row: the sheet is restyled as a whole, so head and body keep ONE painter's hand.
 * Throws when the backend returns no image.
 * @returns {Promise<string>} the styled row (data URI)
 */
async function styleBodyRow(rowImageData, artStyle, { usageTracker = null } = {}) {
  if (!artStyle || artStyle === 'realistic') throw new Error('styleBodyRow: a non-realistic art style is required');
  const result = await styleTransferGenerate(buildStyleTransferPrompt(artStyle, { bodyRowOnly: true }), rowImageData, null, null);
  if (!result?.imageData) throw new Error('styleBodyRow: the style transfer returned no image');
  if (usageTracker && result.usage) usageTracker(result.provider || 'grok', { ...result.usage, cost: result.usage.cost ?? require('../config/models').priceUsage(result.modelId, result.usage) }, 'character_2x4_body_row_style_transfer', result.modelId);
  return result.imageData;
}

/**
 * The DECLARED age, as a proportion instruction (2026-09-14).
 *
 * The sheet prompt used to carry the age only as "match the person's apparent
 * age in Image 3", plus a four-row table whose child rows are "a young child
 * about 5 to 6 [heads], a toddler about 4". Two consequences, both measured on
 * prod job_1789227389389_z18dmvnt6: a declared 5-year-old and a declared
 * 11-year-old produce a BYTE-IDENTICAL prompt, and the only thing separating
 * them is what the model reads off a photograph — against an adult yardstick.
 * Liz (5) came back reading 7-9 and Ayan (8) reading 12-14, and every page
 * then copied those sheets faithfully.
 *
 * The declared age never reached this prompt at all: a grep of the stored
 * 4,511-char prompt found zero occurrences of "preschool", "school-age",
 * "Age cues", "years old", "apparentAge" — or even the word "child".
 *
 * This injects the SAME getAgeCategory → getAgeMarkers text the page prompts
 * and the commissioned reference sheets already use (six child buckets between
 * infant and preteen, at 3.5 / 4 / 4.5 / 5 / 5.5 / 6 head-heights) so the sheet
 * is anchored on the age the parent typed rather than inferred from a photo.
 *
 * Lazy require: promptBuilders pulls in services/prompts at load.
 */
function declaredAgeBlock(character) {
  const raw = character?.age ?? character?.declaredAge;
  const age = parseInt(raw, 10);
  if (!Number.isFinite(age) || age < 0) return '';
  const { getAgeCategory, getAgeMarkers } = require('./promptBuilders');
  const markers = getAgeMarkers(getAgeCategory(age));
  if (!markers) return '';
  return ` This person is ${age} years old: ${markers}. That stated age decides the proportions in every cell — it outranks any impression of age taken from the photo, and the figure is never drawn older or taller than it.`;
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
  // The head/body gutter sits where the rows meet, not at H/2: since the head row is cut at the chest
  // (cropHeadRowToShoulders) it is roughly a quarter of the sheet's height.
  const { mid: gutterY } = await detectSheetRowDivider(imageData, buf, W, H);

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
    { name: 'mid-row gutter',  uniformFrac: rowBand(gutterY) },
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

const SHEET_JUDGE_SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

// Vision-judge dispatcher for the sheet evaluators. `model` is a TEXT_MODELS
// key (e.g. 'gemini-2.5-flash', 'grok-4.3', 'qwen3-vl') or a bare Gemini
// modelId (defaults to google). Production passes nothing → gemini-2.5-flash,
// so the google branch stays byte-identical to the old inline fetch. Grok/Qwen
// reuse the SAME `parts` array (images + prompt) via the existing vision
// helpers. Returns { text, usageMetadata }.
// `_maxOutputTokens` is unused since 2026-09-11 (owner rule: no output caps) —
// kept in the signature so the call sites read unchanged; every judge runs at
// the model's own ceiling.
async function callSheetJudge(model, parts, _maxOutputTokens, geminiApiKey) {
  const { TEXT_MODELS } = require('../config/models');
  const cfg = TEXT_MODELS[model];
  const provider = cfg?.provider || 'google';
  const modelId = cfg?.modelId || model;
  assertPromptFilled(parts, 'callSheetJudge');
  if (provider === 'google') {
    const body = {
      contents: [{ parts }],
      // thinkingBudget: 0 — these are structured scoring judges at temp 0, not
      // open reasoning. Thinking tokens counted against maxOutputTokens and
      // truncated the JSON; disabling them removes that failure mode at the
      // source (and is faster/cheaper). No maxOutputTokens (owner rule: no
      // output caps) — Gemini's default is the model's own ceiling.
      generationConfig: { temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
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
      throw new Error('Gemini eval truncated (finishReason=MAX_TOKENS at the model ceiling)');
    }
    // Same argument, ALLOW-LIST shape (imageReplyGuard, 2026-09-18): every
    // other non-completion — a SAFETY/RECITATION/IMAGE_* refusal, or a reason
    // Google adds later — also returns no text, and parseJudgeJson then throws
    // on `undefined` naming neither the model nor the reason. Say why instead;
    // the retry loop and the caller's fail-open are unchanged.
    const verdict = assessImageResponse(j);
    if (verdict.blocked) throw new Error(`Gemini eval ${describeImageBlock(verdict)}`);
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
function buildStyleTransferPrompt(artStyle, { hasAnchor = false, bodyRowOnly = false } = {}) {
  const styleLine = resolveStyleLineForSheet(artStyle);
  // Image 2's PEOPLE keep bleeding into the sheet (job_1786277779744 2026-08-09;
  // again job_1786484554633 2026-08-12 — the anchor family ghosted across Noah's
  // cells despite the "unrelated people, don't copy" wording). Second-generation
  // wording: never mention that Image 2 contains people at all — call it a
  // swatch, and state the single-subject rule as a property of the OUTPUT
  // ("alone in every cell") rather than a negation about Image 2.
  const anchorLine = hasAnchor
    ? '\nImage 2 is a swatch of the painting technique, brushwork and paper texture only. Take nothing else from it: no figure, face, garment, garment colour, or composition — every painted element and every garment colour in the output comes from Image 1. Where Image 2 and the style text above disagree, the style text wins.'
    : '';
  // The trial styles the full-body row alone, right after it is drawn (docs/decisions.md 2026-10-10): same rules, a 1×4 row.
  const what = bodyRowOnly ? 'a row of four full-body character views (4 cells)' : 'a 2×4 character reference sheet (8 cells)';
  const cells = bodyRowOnly ? 'all 4 cells' : 'all 8 cells';
  const where = bodyRowOnly ? 'in the row' : 'on the sheet';
  return `Change the art style of Image 1 — ${what} — to: ${styleLine}
Render ${cells} uniformly in this style — no cell left photographic.

Keep the content of Image 1 unchanged; only the art style changes. Every cell shows the same single character as Image 1, alone — no other person or figure anywhere ${where}. Hair colour and skin tone stay as Image 1 shows them, with no colour patch on the face that Image 1 does not have. ${garmentColourRule('Image 1')} ${SHEET_GROUND_RULE} ${SHEET_EMPTY_HANDS_RULE} ${SHEET_NO_LETTERING_RULE}${anchorLine}`;
}

// Optional per-art-style STYLE ANCHOR asset (server/assets/style-anchor-<style>.jpg|png)
// — a strong, character-free reference painting of that medium (e.g. a watercolour
// family group). Passed as Image 2 in styleTransferGenerate; the prompt then names
// it. Returns a data URI, or null if no asset exists (graceful → no anchor).
// Single definition lives in styleAnalysis.js — it is a property of the STYLE,
// and the commissioned-style repair gate needs the same asset. Re-exported
// through this name so the call sites below (and the vm-sliced unit test, which
// stubs `loadStyleAnchor`) keep reading the same way.
function loadStyleAnchor(artStyle) {
  return require('./styleAnalysis').loadStyleAnchor(artStyle);
}

/**
 * THE PER-CELL CHECKS OF A STYLED SHEET, one row at a time (2026-10-07).
 *
 * Asked of the whole sheet inside the big style prompt, the judge answered "same person",
 * "illustrated" and "no lettering" for all 8 cells of staging job_1791315635053_t0t8qpebu's
 * sheets: Sarah's body cells 2 and 3 were another woman, three head rows were photographs and
 * Daniel's caption strip was in plain view (replayed, gemini-2.5-flash). Asked ONE short question
 * of one row crop (prompts/sheet-row-cells-eval.txt) the same model read hair colour, glasses and
 * medium per cell correctly. So these four checks are their own call per row, and the big prompt
 * keeps only the whole-sheet tasks.
 */
async function observeStyledRow(rowImageData, { styleLabel, hair = null, model = 'gemini-2.5-flash', usageTracker = null, apiKey = null, promptOverride = null }) {
  const template = promptOverride || PROMPT_TEMPLATES.sheetRowCellsEval;
  if (!template) throw new Error('sheetRowCellsEval prompt template not loaded');
  const prompt = fillTemplate(template, { REQUESTED_STYLE: styleLabel, REQUESTED_HAIR: requestedHairLine(hair), SHEET_LETTERING: SHEET_NO_LETTERING_RULE });
  const report = await askSheetJudge({ model, parts: [inlinePartOf(rowImageData), { text: prompt }], prompt, label: 'row cells eval', usageTracker, usageFn: 'character_2x4_row_cells_eval', apiKey: apiKey || process.env.GEMINI_API_KEY });
  return { report, promptUsed: prompt };
}

/**
 * The hair a character's avatar shows, as the detailedHairAnalysis shape every prompt reads (prompts/avatar-hair-read.txt).
 * ONE call on the whole reference sheet: the generic photo analysis (character-analysis.txt) read Lorena's high ponytail,
 * plainly visible in her side view, as "natural" (staging job_1791450210539_nwi88y9lr, 2026-10-08), so a dedicated question
 * asks the reader to use every view. Used by avatarHair.js (docs/decisions.md "Hair text follows the approved avatar").
 */
async function readAvatarHair(avatarImageData, { model = MODEL_DEFAULTS.sheetEvalModel, usageTracker = null, apiKey = null } = {}) {
  const prompt = PROMPT_TEMPLATES.avatarHairRead;
  if (!prompt) throw new Error('avatarHairRead prompt template not loaded');
  const report = await askSheetJudge({ model, parts: [inlinePartOf(avatarImageData), { text: prompt }], prompt, label: 'avatar hair read', usageTracker, usageFn: 'avatar_hair_read', apiKey: apiKey || process.env.GEMINI_API_KEY });
  return { hair: report?.detailedHairAnalysis || null, seen: report?.seen || null };
}

async function observeStyledRows(styledSheet, opts) {
  const { topHeads, bottomBody } = await splitSheetRows(styledSheet);
  return Promise.all([topHeads, bottomBody].map(row => observeStyledRow(row, opts)));
}

// Fold the two rows' answers into the style report as the per-cell fields applyStyledSheetConsistencyAxes
// reads: top-row cell k is cell k, bottom-row cell k is cell k+4.
function mergeRowObservations(report, top, bottom) {
  const perCell = (field) => {
    const out = {};
    [top.report, bottom.report].forEach((row, r) => {
      for (let k = 1; k <= 4; k++) {
        const v = row?.cells?.[`cell${k}`]?.[field];
        if (typeof v === 'string') out[`cell${k + 4 * r}`] = v;
      }
    });
    return out;
  };
  report.style = { ...report.style, perCell: perCell('medium') };
  report.identity = { ...report.identity, perCell: perCell('person') };
  // The rows' own reasons ride with the verdict: a 'differs' on a stored sheet can then be read (what hair, which parting
  // the judge saw) instead of re-run — the Fiona rerun's 8/8 hair verdicts could not be reproduced from the stored sheet.
  const rowReason = [['heads', top.report], ['bodies', bottom.report]].filter(([, r]) => typeof r?.reason === 'string').map(([k, r]) => `${k}: ${r.reason}`).join(' | ');
  report.hair = { perCell: perCell('hair'), ...(rowReason ? { reason: rowReason } : {}) };
  const seen = [top.report, bottom.report].map(r => r?.letteringSeen);
  if (seen.every(v => typeof v === 'boolean')) {
    report.letteringSeen = seen.some(Boolean);
    report.letteringQuoted = [top.report.letteringQuoted, bottom.report.letteringQuoted].filter(q => q && String(q).toLowerCase() !== 'none').join(' / ') || 'none';
  }
  return report;
}

/**
 * Pass 2 evaluator — verifies the style-transferred sheet preserves identity
 * + layout, AND that the requested style was actually applied
 * (rather than the model returning the source unchanged, as Gemini tends to).
 *
 * Receives THREE images in order: source face photo, Pass 1 realistic sheet,
 * Pass 2 styled sheet. Returns parsed JSON verdict from
 * prompts/sheet-2x4-style-eval.txt.
 */
async function evaluateStyledSheetWithGemini(sourcePhoto, realisticSheet, styledSheet, artStyle, geminiApiKey, usageTracker = null, declaredAge = null, opts = {}) {
  // model / promptOverride: Test Lab A/B only; production passes neither.
  // Pass 2 is a STYLE TRANSFER: the restyler is never told which garments to
  // produce (buildStyleTransferPrompt takes no costume), so the judge must not
  // ask. The outfit is decided and scored on pass 1 — no costume input here.
  // What pass 2 IS told is to keep each garment's colour from the pass-1 sheet
  // (garmentColourRule), so the judge scores exactly that, against Image 2.
  // imageLabels: Test Lab A/B only (sheetJudgeArms.js) — three caption strings
  // sent as text parts before Image 1/2/3. Production passes none: the images
  // go first, unlabelled, then the prompt.
  const { model = 'gemini-2.5-flash', promptOverride = null, imageLabels = null, rowObservations = null } = opts;
  const styleLabel = resolveStyleLineForSheet(artStyle);

  let prompt = promptOverride || PROMPT_TEMPLATES.sheet2x4StyleEval;
  if (!prompt) throw new Error('sheet2x4StyleEval prompt template not loaded');
  prompt = fillTemplate(prompt, { REAR_TURN: REAR_TURN_POSE, SHEET_GROUND: SHEET_GROUND_RULE, SHEET_LETTERING: SHEET_NO_LETTERING_RULE, GARMENT_COLOUR: garmentColourRule('Image 2') });
  prompt = prompt.replace(/REQUESTED_STYLE/g, `REQUESTED_STYLE: ${styleLabel}`);
  // TASK 6 age gate — style transfer is where kids drift younger (the art
  // style's cute prior). Unknown age disables the task (prompt scores it 10).
  const ageNum = parseInt(declaredAge, 10);
  prompt = prompt.replace(/CHARACTER_AGE/g, Number.isFinite(ageNum) ? `${ageNum} years old` : 'unknown');
  const toInlinePart = (dataUri) => {
    const b64 = r2.stripDataUriPrefix(dataUri);
    const mime = dataUri.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    return { inline_data: { mime_type: mime, data: b64 } };
  };

  // No output cap (owner rule): a 2500 cap once truncated this JSON mid-string
  // when the TASK-5 colour enumeration made the model think longer.
  const images = [sourcePhoto, realisticSheet, styledSheet].map(toInlinePart);
  if (imageLabels != null && (!Array.isArray(imageLabels) || imageLabels.length !== 3)) {
    throw new Error('evaluateStyledSheetWithGemini: imageLabels must be three strings (Image 1, 2, 3)');
  }
  const parts = [
    ...(imageLabels ? images.flatMap((img, i) => [{ text: String(imageLabels[i]) }, img]) : images),
    { text: prompt },
  ];
  const report = await askSheetJudge({ model, parts, prompt, label: 'style-eval', usageTracker, usageFn: 'character_2x4_style_eval', apiKey: geminiApiKey });
  // The per-cell checks (medium, hair, one person, lettering) are a separate, focused question asked
  // of each row on its own (observeStyledRows). evaluateAvatarSheet — the one entry production and the
  // Lab both use — asks them and passes the answers here; a direct call without them judges the
  // whole-sheet tasks only.
  const rows = rowObservations ? await rowObservations : null;
  if (rows) mergeRowObservations(report, rows[0], rows[1]);
  applyStyledSheetConsistencyAxes(report);
  return { report: scoreStyleReport(report), promptUsed: prompt, rowPromptUsed: rows?.[0]?.promptUsed || null };
}

/**
 * IS ONE TAKEN-OFF GARMENT STILL ON THE SHEET? One question, one garment, the
 * variant image ALONE (owner, 2026-10-04). Inside the style judge the same
 * question was read as an exemption: Image 2 still wears the garment, so "TASK 9
 * does not score it" and "no garments were requested to be taken off" passed
 * sheets that still wore it (Lab #1597/#1598: 3 of 4 control runs). With no
 * reference image there is nothing to excuse it. Same provider and model as the
 * style judge (askSheetJudge: Gemini Flash, temperature 0, echo guard).
 * A failed call throws — the caller rejects the variant, never ships it unchecked.
 *
 * @returns {Promise<{garment: string, visible: boolean, cells: string, reason: string}>}
 */
async function checkGarmentGone(sheet, garment, opts = {}) {
  const { model = 'gemini-2.5-flash', usageTracker = null } = opts;
  const name = String(garment || '').trim();
  if (!name) throw new Error('checkGarmentGone: no garment named');
  const template = PROMPT_TEMPLATES.sheetGarmentGoneCheck;
  if (!template) throw new Error('sheetGarmentGoneCheck prompt template not loaded');
  const prompt = fillTemplate(template, { GARMENT: name, PARTS: `${GARMENT_PARTS} of it, worn or held` });
  const report = await askSheetJudge({
    model, parts: [inlinePartOf(sheet), { text: prompt }], prompt,
    label: `garment-gone check (${name})`, usageTracker, usageFn: 'character_2x4_garment_gone_check', apiKey: process.env.GEMINI_API_KEY,
  });
  if (typeof report?.visible !== 'boolean') throw new Error(`garment-gone check (${name}) returned no visible true/false`);
  // `question` is the exact text asked: the stored verdict must be readable on its own.
  return { garment: name, question: prompt, visible: report.visible, cells: String(report.cells ?? ''), reason: String(report.reason ?? '') };
}

/**
 * IS ONE GARMENT THAT SHOULD STAY STILL ON THE SHEET'S BODY ROW? The mirror of
 * checkGarmentGone, and not a copy of its question: asked of any cell, a kept
 * baldric drawn only in the four head cells passed (staging
 * job_1791145238223_50osg2osm, Daniel: baldric gone from the body row, still in
 * the head row), and asked of all 8 cells, a belt is "missing" from every head
 * cell, which are cropped above the waist. So: one garment, body cells 5-8, the
 * variant image alone. A failed call throws, like checkGarmentGone.
 *
 * @returns {Promise<{garment: string, question: string, visible: boolean, cells: string, reason: string}>}
 */
async function checkKeptGarment(sheet, garment, opts = {}) {
  const { model = 'gemini-2.5-flash', usageTracker = null } = opts;
  // The Art Director's structured entry {type, colour, details}: only colour and
  // type reach the question. `details` (fabric, cut) is never sent: a judge reads
  // a fabric word literally (Lab #1614-#1620: "corduroy" flagged a correct sheet 8/8).
  const type = String(garment?.type || '').trim();
  const colour = String(garment?.colour || '').trim();
  if (!type || !colour) throw new Error('checkKeptGarment: a kept garment needs a type and a colour');
  const name = `${colour} ${type}`;
  const template = PROMPT_TEMPLATES.sheetKeptGarmentCheck;
  if (!template) throw new Error('sheetKeptGarmentCheck prompt template not loaded');
  const prompt = fillTemplate(template, { GARMENT: name });
  const report = await askSheetJudge({
    model, parts: [inlinePartOf(sheet), { text: prompt }], prompt,
    label: `kept-garment check (${name})`, usageTracker, usageFn: 'character_2x4_kept_garment_check', apiKey: process.env.GEMINI_API_KEY,
  });
  if (typeof report?.visible !== 'boolean') throw new Error(`kept-garment check (${name}) returned no visible true/false`);
  return { garment: name, type, colour, question: prompt, visible: report.visible, cells: String(report.cells ?? ''), reason: String(report.reason ?? '') };
}

/**
 * THE VARIANT GATE: the pass-2 style judge AND one garment-gone check per
 * removed garment. It passes only when the style judge passes and every check
 * says not visible. The checks ride on the style verdict as `garmentChecks`;
 * a visible garment sets removedScore 1 and `removed.reason`, so the
 * finding/axis plumbing reads it as an axis.
 */
async function evaluateVariantSheet(sheet, opts = {}) {
  const { removedGarments = [], keptGarments = null, keptCheckSkipped = null, usageTracker = null, ...styleOpts } = opts;
  const names = (Array.isArray(removedGarments) ? removedGarments : []).map(s => String(s || '').trim()).filter(Boolean);
  const styled = await evaluateAvatarSheet(sheet, { ...styleOpts, pass: 2, usageTracker });
  // The kept list is required unless the caller says why no kept check runs
  // (an outfit version authors none): a variant is never gated on half the question.
  const kept = Array.isArray(keptGarments) ? keptGarments : [];
  if (!kept.length && !keptCheckSkipped) throw new Error('evaluateVariantSheet: no keptGarments and no keptCheckSkipped reason');
  const [checks, keptChecks] = await Promise.all([
    Promise.all(names.map(g => checkGarmentGone(sheet, g, { usageTracker }))),
    Promise.all(kept.map(g => checkKeptGarment(sheet, g, { usageTracker }))),
  ]);
  const verdict = styled.verdict;
  // The style judge's own answer, before a visible garment lowers the final.
  verdict.styleGate = { finalScore: verdict.finalScore, valid: verdict.valid, failureReasons: [...(verdict.failureReasons || [])] };
  verdict.garmentChecks = checks;
  verdict.keptChecks = keptChecks;
  verdict.keptCheckSkipped = kept.length ? null : keptCheckSkipped;
  const still = checks.filter(c => c.visible);
  verdict.removedScore = still.length ? 1 : 10;
  verdict.removed = { score: verdict.removedScore, reason: still.length ? still.map(c => `${c.garment} is still visible: ${c.reason}`).join('; ') : 'no taken-off garment is visible in any cell' };
  if (still.length) {
    verdict.finalScore = Math.min(verdict.finalScore, verdict.removedScore);
    verdict.valid = false;
    verdict.failureReasons = [...(verdict.failureReasons || []), ...still.map(c => `removed: ${c.garment} is still visible — ${c.reason}`)];
  }
  const missing = keptChecks.filter(c => !c.visible);
  verdict.keptScore = missing.length ? 1 : (kept.length ? 10 : null);
  if (missing.length) {
    verdict.finalScore = Math.min(verdict.finalScore, 1);
    verdict.valid = false;
    verdict.failureReasons = [...(verdict.failureReasons || []), ...missing.map(c => `kept: ${c.garment} is missing from the body cells — ${c.reason}`)];
  }
  return { ...styled, verdict };
}

// ── Every sheet judge's final score is computed HERE ─────────────────────────
// A judge returns sub-scores and a finalScore that its template defines as the
// lowest of them. Only the bodies row used to be recomputed in code
// (applyPoseHeadGate); the heads, identity and style verdicts shipped whatever
// finalScore the model wrote, so a model that miscounted its own min — or, as
// on staging job_1790100385959_1nitlympp, copied an example whose finalScore
// did not match its sub-scores — decided the gate. One rule for all four: the
// final is the lowest sub-score present, valid is final >= 6, and an axis that
// fails without a reason of its own gets one so the retry log names it. A
// verdict with no sub-score at all was never a verdict and throws, which the
// callers already record as unjudged.
const SHEET_VALID_MIN = 6;

function lowestAxis(report, axes, label) {
  const scored = axes
    .map(([name, pick]) => ({ name, v: pick(report) }))
    .filter(a => typeof a.v === 'number' && Number.isFinite(a.v));
  if (!scored.length) throw new Error(`${label} returned no sub-scores`);
  const missing = axes.map(([n]) => n).filter(n => !scored.some(a => a.name === n));
  if (missing.length) log.warn(`[CHARACTER 2×4] ${label} omitted ${missing.join(', ')} — final taken over the axes it did score`);
  const final = Math.min(...scored.map(a => a.v));
  const failing = scored.filter(a => a.v < SHEET_VALID_MIN).map(a => a.name);
  return { final, failing };
}

function stampVerdict(report, { final, failing }) {
  report.finalScore = final;
  report.valid = final >= SHEET_VALID_MIN;
  const reasons = Array.isArray(report.failureReasons) ? report.failureReasons.slice() : [];
  for (const axis of failing) {
    // `<axis>:` - a bare field name ("backgroundScore", staging job_1791531449494_o0kaatvmq
    // Julian) is not a reason, and used to hide the axis's own `reason` from the log.
    const named = new RegExp(`^${axis}\s*[:—-]`, 'i');
    if (!reasons.some(r => named.test(String(r).trim()))) {
      const why = report[axis]?.reason;
      reasons.push(`${axis}: ${why || 'scored below ' + SHEET_VALID_MIN}`);
    }
  }
  report.failureReasons = reasons;
  return report;
}

const HEADS_AXES = [
  ['angles', r => r.angles?.score],
  ['cleanRender', r => r.cleanRender?.cleanScore],
  ['coverage', r => r.coverage?.coverageScore],
  ['solo', r => r.solo?.soloScore],
  ['crop', r => r.crop?.cropScore],
  ['glasses', r => r.glasses?.glassesScore],
  ['hair', r => r.hair?.hairScore],
  ['person', r => r.person?.personScore],
];
function scoreHeadsReport(report) {
  return stampVerdict(report, lowestAxis(report, HEADS_AXES, 'row eval (heads)'));
}

const STYLE_AXES = ['layout', 'identity', 'style', 'clean', 'bodyFace', 'age', 'solo', 'background', 'garment', 'hair']
  .map(n => [n, r => r[`${n}Score`] ?? r[n]?.score]);
// The style-judge axes a styled sheet may NOT fail and still ship: a different
// person (identity) or extra people in the sheet (solo). Every other axis ships
// with a warning on the final strike — see generateCharacter2x4Sheet.
const STYLED_IDENTITY_AXES = ['identity', 'solo'];
// HARD FAIL (2026-10-09). The style judge's own bands: 1-3 is a wrecked layout, a
// different person, an extra person, a photographic sheet, a scene behind the
// figures, a recoloured garment. An axis at or below this is not a rough edge a
// shipped sheet can carry; it earns ONE extra, fed-back attempt (below) and, if
// that fails too, a loud ERROR when the best sheet ships. Staging
// job_1791531449494_o0kaatvmq: Julian background 3/10 (two adult strangers
// painted behind the head cells), Levin hair 1/10 (light blonde declared,
// ginger-brown painted) - both shipped on the old ship-best path.
const SHEET_HARD_FAIL_MAX = 3;

// What a retry tells Grok about a failed axis: ONE fixed instruction per axis plus
// the judge's own reading of the rejected sheet. No story, name or place in the
// wording - the axis is the only variable. The hair axis states the DECLARED hair
// and names the cells the judge flagged (its per-cell reason repeats one reading
// eight times, so the flagged cells carry it).
const STYLE_AXIS_FEEDBACK = {
  layout: () => 'Keep the 4 by 2 grid of Image 1: eight separate cells, each facing the way the same cell of Image 1 faces.',
  identity: () => 'Every cell shows the same person as Image 1, with the same face.',
  style: () => 'Every cell is fully painted in the requested style, none left photographic.',
  clean: () => 'No colour patch, streak, mark or symbol on the skin, hair or clothes that Image 1 does not have.',
  bodyFace: () => 'Every body cell shows a complete face: eyes, nose and mouth.',
  age: () => 'The figure keeps the age and the body proportions of Image 1.',
  solo: () => 'Only the one character appears, in every cell: no second face, figure or partial person anywhere.',
  background: () => 'The ground behind and around every figure is plain blank paper: no other person, face or figure and no scenery anywhere on the sheet.',
  garment: () => 'Every garment keeps exactly the colour it has in Image 1.',
  hair: (verdict, { hair }) => {
    const bad = Object.entries(verdict?.hair?.perCell || {})
      .filter(([, v]) => String(v).trim().toLowerCase() === 'differs').map(([k]) => k.replace(/^cell/, ''));
    const where = bad.length ? `Cells ${bad.join(', ')} showed other hair. ` : '';
    return `${where}Every cell shows the requested hair, ${hair || 'the same hair as Image 1'}, in one colour, length and style.`;
  },
};

// The fed-back lines for a rejected styled verdict: one per axis at or below
// SHEET_HARD_FAIL_MAX, lowest first. [] means nothing is hard-failed and no extra
// attempt is owed. The axis score is read from the flat `<axis>Score` the verdict
// carries (scoreStyleReport); the judge's reading from `<axis>.reason`.
function hardFailFeedback(verdict, { hair = null } = {}) {
  if (!verdict || typeof verdict !== 'object') return [];
  const failed = Object.keys(STYLE_AXIS_FEEDBACK)
    .map(axis => ({ axis, score: verdict[`${axis}Score`] ?? verdict[axis]?.score }))
    .filter(a => typeof a.score === 'number' && a.score <= SHEET_HARD_FAIL_MAX)
    .sort((a, b) => a.score - b.score);
  return failed.map(({ axis }) => {
    const rule = STYLE_AXIS_FEEDBACK[axis](verdict, { hair });
    const reason = axis === 'hair' ? '' : String(verdict[axis]?.reason || '').trim();
    return reason ? `${axis}: ${rule} The judge saw: ${reason}` : `${axis}: ${rule}`;
  });
}

// The retry prompt: the base style-transfer prompt plus the failed axes, stated.
function buildFedBackPrompt(basePrompt, lines) {
  if (!lines || !lines.length) return basePrompt;
  return `${basePrompt}\n\nTHE PREVIOUS ATTEMPT WAS REJECTED. Correct exactly this, change nothing else:\n${lines.map(l => `- ${l}`).join('\n')}`;
}

function scoreStyleReport(report) {
  const verdict = lowestAxis(report, STYLE_AXES, 'style-eval');
  // The flat xScore fields are what runStyleTransferPass logs and stores.
  for (const [n, pick] of STYLE_AXES) {
    const v = pick(report);
    if (typeof v === 'number') report[`${n}Score`] = v;
  }
  return stampVerdict(report, verdict);
}

// Identity is the lowest CELL; the per-cell scores are the observations.
function scoreIdentityReport(report) {
  const cells = Object.values(report?.perCell || {}).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (cells.length) report.identityScore = Math.min(...cells);
  if (typeof report?.identityScore !== 'number') throw new Error('identity eval returned no score');
  return report;
}

// ── Degenerate-judge guard, shared by EVERY sheet judge ──────────────────────
// A sheet judge sometimes returns text it was shown instead of a verdict. Three
// shapes are measured: the template's worked example verbatim (pass 2, Noah,
// job_1786484554633: all-9s over a sheet full of ghost figures), the same for
// all three pass-1 row judges (staging job_1790100385959_1nitlympp: 6/6 sheets,
// every reason string and every score the example's, over sheets with a
// duplicated profile and an invented collar), and TASK sentences lifted into the
// reason (the same run's pass-2 layout reason was TASK 1's text on 5 of 6
// sheets, over a sheet whose top row is not head cells at all). Every template
// now shows `<placeholder>` examples and asks for per-cell observations; a
// verdict still carrying a placeholder, a pre-2026-09-23 example string, or a
// reason made only of the prompt's own sentences was never judged. It is
// re-asked once, then the eval throws so the caller records it as unjudged.
const LEGACY_EXAMPLE_REASONS = ([
  // pass-2 style eval, before 2026-08-12
  'Same 4×2 grid as Image 2, no figure crosses gutters',
  'Only the target character appears; no other or extra people in any cell',
  // pass-1 row evals, before 2026-09-23
  'Front, three-quarter, profile, back left to right',
  'No arrows or stray marks on any head',
  'Visible shoulders are clothed in the requested garment in every cell',
  'One head per cell, four separate heads, no extra or ghosted person',
  'Every figure wears the requested items, consistent across cells',
  'Reads as the requested costume; 10 when none was requested',
  'One figure per cell, four separate figures, no extra or ghosted person',
  'Proportions match the stated age',
  'Plain white background in every cell',
  'All 4 heads match the reference person in face structure, hair, skin tone, and age',
]).map(x => x.toLowerCase());

function judgeReasons(verdict) {
  if (!verdict || typeof verdict !== 'object') return [];
  const out = [];
  if (typeof verdict.reason === 'string') out.push(verdict.reason);
  for (const v of Object.values(verdict)) {
    if (v && typeof v === 'object' && typeof v.reason === 'string') out.push(v.reason);
  }
  return out;
}

const normEcho = (t) => String(t).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// True when the reason is two or more sentences and every one of them is a
// sentence of the prompt. A reason that adds one observation of its own is not
// an echo, however much task wording it repeats; a single restated criterion is
// left to the judge (too close to an honest one-line pass to fail a sheet on).
function isLiftedFromPrompt(reason, promptText) {
  const prompt = normEcho(promptText);
  const sentences = normEcho(reason).split(/(?<=[.!?])\s+|;\s*/)
    .map(x => x.replace(/^[-–•*\s]+|[.!?,;:\s]+$/g, ''))
    .filter(Boolean);
  return sentences.length >= 2 && sentences.every(x => prompt.includes(x));
}

function isEchoedJudgeVerdict(verdict, promptText) {
  const reasons = judgeReasons(verdict);
  if (reasons.length === 0) return false;
  return reasons.some(r => r.includes('<') || isLegacyExample(r) || isLiftedFromPrompt(r, promptText));
}

// The run's identity judge returned the example with a full stop, or with one
// clause appended ("… and age. The character appears to be around 3."), so a
// long example string is matched as the reason's opening, a short one exactly.
function isLegacyExample(reason) {
  const r = normEcho(reason).replace(/[.!?\s]+$/, '');
  return LEGACY_EXAMPLE_REASONS.some(ex => r === ex || (ex.length >= 40 && r.startsWith(ex)));
}

// One call to a sheet judge with the echo guard: re-ask once, then throw.
async function askSheetJudge({ model, parts, prompt, label, usageTracker, usageFn, apiKey }) {
  for (let evalTry = 1; evalTry <= 2; evalTry++) {
    const { text, usageMetadata } = await callSheetJudge(model, parts, null, apiKey);
    if (!text) throw new Error(`${label} (${model}) returned no text`);
    if (usageTracker && usageMetadata) {
      usageTracker('gemini_quality', geminiUsage(usageMetadata), usageFn, model);
    }
    const verdict = parseJudgeJson(text);
    if (!isEchoedJudgeVerdict(verdict, prompt)) return verdict;
    log.warn(`[CHARACTER 2×4] ${label} returned text from its own prompt instead of a verdict (try ${evalTry}/2) — ${evalTry < 2 ? 're-asking' : 'failing the eval'}`);
  }
  throw new Error(`${label} echoed its prompt twice — degenerate judge response`);
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
    const j = await analyzerJson('/pose-heads', { image: bottomBodyImageData, cols: 4 }, { timeoutMs: 60_000 });
    if (!Array.isArray(j.cells)) throw new AnalyzerError('/pose-heads', `answered without cells: ${JSON.stringify(j).slice(0, 120)}`);
    return j;
  } catch (err) {
    // Reported (ERROR + failure_log analyzer_pose_heads_failed). The null is
    // the explicit "pose unavailable" signal applyPoseHeadGate stamps as
    // headSource 'gemini-fallback' — a marked degraded result, never a score.
    reportAnalyzerFailure('[CHARACTER 2×4] /pose-heads — bodies head-check falls back to Gemini', err);
    return null;
  }
}

// Returns { mid, source }: source 'analyzer' for the edge-detected divider,
// 'variance-fallback' when the analyzer could not answer (reported, ERROR +
// failure_log) or found no usable separator (warned) — so a split can never
// pass as edge-detected when it was not.
async function detectSheetRowDivider(imageData, buf, W, H) {
  try {
    const j = await analyzerJson('/split-reference-sheet', { image: imageData, count: 8, cols: 4, rows: 2 }, { timeoutMs: 60_000 });
    const h = j?.separators?.horizontal;
    if (Array.isArray(h) && h.length && h[0] > 0 && h[0] < H) return { mid: Math.round(h[0]), source: 'analyzer' };
    log.warn(`[CHARACTER 2×4] split-reference-sheet gave no horizontal separator — falling back to variance detector`);
  } catch (err) {
    reportAnalyzerFailure('[CHARACTER 2×4] split-reference-sheet — falling back to variance detector', err);
  }
  const { detectMinVarianceSeparator } = require('./grok');
  const { data } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { mid: detectMinVarianceSeparator(data, W, H, 'h', 0.25, 0.75), source: 'variance-fallback' };
}

async function splitSheetRows(imageData) {
  const buf = Buffer.from(r2.stripDataUriPrefix(imageData), 'base64');
  const { width: W, height: H } = await sharp(buf).metadata();
  const { mid, source: splitSource } = await detectSheetRowDivider(imageData, buf, W, H);
  const [top, bottom] = await Promise.all([
    sharp(buf).extract({ left: 0, top: 0, width: W, height: mid }).jpeg().toBuffer(),
    sharp(buf).extract({ left: 0, top: mid, width: W, height: H - mid }).jpeg().toBuffer(),
  ]);
  return {
    topHeads: 'data:image/jpeg;base64,' + top.toString('base64'),
    bottomBody: 'data:image/jpeg;base64,' + bottom.toString('base64'),
    splitY: mid, splitSource, width: W, height: H,
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
// The glasses axis is COMPUTED, never scored by the judge: asked for a 1-10 score, the judge
// listed two glassless faces in its own reason and still wrote 7-9 (replay over Sarah's stored
// head row, staging job_1791267520938_essbvehs8). It answers yes / no / na per cell; one `no`
// is a failed axis. Nothing declared: the axis is 10 and the cells are not read.
function applyGlassesAxis(report, glasses) {
  if (!report || typeof report !== 'object') return report;
  const cells = report.glasses && report.glasses.perCell && typeof report.glasses.perCell === 'object' ? Object.values(report.glasses.perCell) : [];
  const missing = glasses ? cells.filter(v => String(v).trim().toLowerCase() === 'no') : [];
  if (glasses && !cells.length) log.warn(`[CHARACTER 2×4] the row judge returned no per-cell glasses answer although "${glasses}" is declared — the axis is unscored`);
  report.glasses = {
    ...(report.glasses || {}),
    ...(glasses && !cells.length ? {} : { glassesScore: missing.length ? 1 : 10 }),
  };
  if (missing.length) report.failureReasons = [...(report.failureReasons || []), `glasses: ${missing.length} cell(s) show a face without the declared ${glasses}`];
  return report;
}

// ── Per-cell answers are computed into axes, never scored by the judge ─────────
// (the glasses lesson above: a judge that lists two wrong faces in its own reason still writes 7-9.)
// perCellVerdict reads `report[key].perCell` — one short answer per cell — and returns
// { score: 1 | 10, bad: [cellNames] }, or null (warned) when the judge gave no per-cell answer, so a
// missing answer leaves the axis unscored instead of passing it.
function perCellVerdict(report, key, badAnswer) {
  const per = report?.[key]?.perCell;
  const cells = per && typeof per === 'object' ? Object.entries(per) : [];
  if (!cells.length) {
    log.warn(`[CHARACTER 2×4] the sheet judge returned no per-cell answer for "${key}" — the axis is unscored`);
    return null;
  }
  const bad = cells.filter(([, v]) => String(v).trim().toLowerCase() === badAnswer).map(([k]) => k);
  return { score: bad.length ? 1 : 10, bad };
}

// The paper holds no lettering. The judge states what it saw as a boolean beside its quote: a judge
// that read "Front / Three-quarter / Profile / Rear turn" under a row and scored the ground 10
// ("part of the reference sheet structure") is overruled by its own observation.
function letteringSeen(report) {
  if (typeof report?.letteringSeen === 'boolean') return report.letteringSeen;
  log.warn('[CHARACTER 2×4] the sheet judge returned no letteringSeen true/false — lettering is unscored');
  return null;
}

function failWith(report, reason) {
  report.failureReasons = [...(Array.isArray(report.failureReasons) ? report.failureReasons : []), reason];
}

const requestedHairLine = (hair) => (hair ? `REQUESTED_HAIR: ${hair}` : 'REQUESTED_HAIR: none declared');

// Pass-1 row judges: hair and one-person-across-cells, and lettering folded into the row's own
// clean / background axis. Called before the row's final is computed.
function applyRowConsistencyAxes(report, which) {
  if (!report || typeof report !== 'object') return report;
  const hair = perCellVerdict(report, 'hair', 'differs');
  if (hair) {
    report.hair = { ...report.hair, hairScore: hair.score };
    if (hair.bad.length) failWith(report, `hair: ${hair.bad.join(', ')} differ from the requested hair or from the other cells`);
  }
  const person = perCellVerdict(report, 'person', 'different');
  if (person) {
    report.person = { ...report.person, personScore: person.score };
    if (person.bad.length) failWith(report, `person: ${person.bad.join(', ')} show a different person from the other cells`);
  }
  if (letteringSeen(report) === true) {
    const [key, scoreKey] = which === 'heads' ? ['cleanRender', 'cleanScore'] : ['background', 'backgroundScore'];
    report[key] = { ...report[key], [scoreKey]: Math.min(report[key]?.[scoreKey] ?? 10, 2) };
    failWith(report, `${key}: lettering on the sheet (${report.letteringQuoted || 'quote missing'})`);
  }
  return report;
}

// Pass-2 style judge: every one of the 8 cells is read for medium, for being the same person, and for
// hair. A photographic cell fails the style axis, a different person fails identity (a hard axis —
// STYLED_IDENTITY_AXES), a hair mismatch fails hair, lettering fails the ground.
function applyStyledSheetConsistencyAxes(report) {
  if (!report || typeof report !== 'object') return report;
  const style = perCellVerdict(report, 'style', 'photographic');
  if (style) {
    report.styleScore = Math.min(report.styleScore ?? report.style?.score ?? 10, style.score);
    report.style = { ...report.style, score: report.styleScore };
    if (style.bad.length) failWith(report, `style: ${style.bad.join(', ')} are photographic, not in the requested style`);
  }
  const person = perCellVerdict(report, 'identity', 'different');
  if (person) {
    report.identityScore = Math.min(report.identityScore ?? report.identity?.score ?? 10, person.score);
    report.identity = { ...report.identity, score: report.identityScore };
    if (person.bad.length) failWith(report, `identity: ${person.bad.join(', ')} show a different person from cell 1`);
  }
  const hair = perCellVerdict(report, 'hair', 'differs');
  if (hair) {
    report.hairScore = hair.score;
    report.hair = { ...report.hair, score: hair.score };
    if (hair.bad.length) failWith(report, `hair: ${hair.bad.join(', ')} differ from the requested hair or from Image 2`);
  }
  if (letteringSeen(report) === true) {
    report.backgroundScore = Math.min(report.backgroundScore ?? report.background?.score ?? 10, 2);
    report.background = { ...report.background, score: report.backgroundScore };
    failWith(report, `background: lettering on the sheet (${report.letteringQuoted || 'quote missing'})`);
  }
  return report;
}

async function evaluateSheetRow(rowImageData, which, opts = {}) {
  const { costumeDescription = '', costumeName = null, model = 'gemini-2.5-flash', promptOverride = null, usageTracker = null, declaredAge = null, glasses = null, hair = null } = opts;
  const tplKey = which === 'heads' ? 'sheetRowHeadsEval' : 'sheetRowBodiesEval';
  let prompt = promptOverride || PROMPT_TEMPLATES[tplKey];
  if (!prompt) throw new Error(`${tplKey} template not loaded`);
  // CHARACTER_AGE (bodies only): the proportions task used to score against the
  // figure's own apparent age, so the generator was anchored on the DECLARED age
  // (declaredAgeBlock) while its critic was not — the judge could only confirm
  // that the drawing looked like itself. Same fill as the identity and pass-2
  // style evals. Unknown age → the prompt falls back to apparent age.
  const ageNum = parseInt(declaredAge, 10);
  prompt = fillTemplate(prompt, {
    REAR_TURN: REAR_TURN_POSE,
    SHEET_LETTERING: SHEET_NO_LETTERING_RULE,
    REQUESTED_OUTFIT: costumeDescription ? `REQUESTED_OUTFIT: ${costumeDescription}` : '',
    REQUESTED_GLASSES: glasses ? `REQUESTED_GLASSES: ${glasses}` : 'REQUESTED_GLASSES: none declared',
    REQUESTED_HAIR: requestedHairLine(hair),
    TAIL_POSE: TAIL_POSE_RULE,
    ...(which === 'bodies'
      ? {
        REQUESTED_COSTUME: costumeName ? `REQUESTED_COSTUME: ${costumeName}` : '',
        CHARACTER_AGE: `CHARACTER_AGE: ${Number.isFinite(ageNum) && ageNum >= 0 ? `${ageNum} years old` : 'unknown'}`,
      }
      : {}),
  });
  const parts = [inlinePartOf(rowImageData), { text: prompt }];
  // No cap (owner rule: no output caps): a 4000 cap once truncated the bodies
  // JSON mid-string, and the throw cost three characters their whole ref sheet.
  const raw = await askSheetJudge({ model, parts, prompt, label: `row eval (${which})`, usageTracker, usageFn: `character_2x4_${which}_eval`, apiKey: process.env.GEMINI_API_KEY });
  applyGlassesAxis(raw, glasses);
  applyRowConsistencyAxes(raw, which);
  // bodies: recomputed by applyPoseHeadGate, which also owns the head axis.
  const report = which === 'heads' ? scoreHeadsReport(raw) : raw;
  return { report, promptUsed: prompt };
}

// IDENTITY eval — reference faces (photo + avatar faces) + the HEADS crop only.
// Identity is a face question, so it runs on the head row; the body row's
// identity is not relevant (user direction). Returns {perCell, identityScore}.
async function evaluateIdentity(headsCrop, opts = {}) {
  const { sourcePhoto = null, avatarFaces = null, model = 'gemini-2.5-flash', usageTracker = null, declaredAge = null, promptOverride = null } = opts;
  let prompt = promptOverride || PROMPT_TEMPLATES.sheetRowIdentityEval;
  if (!prompt) throw new Error('sheetRowIdentityEval template not loaded');
  // Same pattern as the Pass-2 style eval's CHARACTER_AGE fill (job_1788215224103:
  // Fiona/Lorena avatar sheets read 40-45 vs stated 25 and 35-40 vs 22 — this
  // check passed both because nothing asked about age).
  const ageNum = parseInt(declaredAge, 10);
  prompt = fillTemplate(prompt, { REAR_TURN: REAR_TURN_POSE })
    .replace(/CHARACTER_AGE/g, Number.isFinite(ageNum) ? `${ageNum} years old` : 'unknown');
  const parts = [];
  if (sourcePhoto) parts.push(inlinePartOf(sourcePhoto));
  if (avatarFaces) parts.push(inlinePartOf(avatarFaces));
  parts.push(inlinePartOf(headsCrop));
  parts.push({ text: prompt });
  // No cap (owner rule: no output caps) — a low cap truncated the JSON.
  const report = await askSheetJudge({ model, parts, prompt, label: 'identity eval', usageTracker, usageFn: 'character_2x4_identity_eval', apiKey: process.env.GEMINI_API_KEY });
  return { report: scoreIdentityReport(report), promptUsed: prompt };
}

// Shared split evaluator — the SINGLE implementation used by BOTH production
// (generateCharacter2x4Sheet) and the Test Lab, so they judge identically.
// THREE calls: (1) heads structure — crop alone; (2) bodies structure — crop
// alone; (3) identity — reference faces + the heads crop. Structure never sees
// the reference faces (so the head-check can't be fooled by them); identity uses
// them but only against the heads. Returns the sub-reports + a merged `verdict`
// whose flat fields are a drop-in for the whole-sheet verdict the retry gate reads.
async function evaluateSheetSplit(sheetImageData, opts = {}) {
  // promptOverrides: Test Lab only — { heads?, bodies?, identity? }, each
  // replacing that ONE judge's template. Production passes none.
  const { facePhoto = null, standardAvatar = null, costumeDescription = 'standard outfit', costumeName = null, model = 'gemini-2.5-flash', promptOverrides = {}, usageTracker = null, declaredAge = null, glasses = null, hair = null } = opts;
  const avatarFaces = standardAvatar ? (await splitSheetRows(standardAvatar)).topHeads : null;
  const { topHeads, bottomBody, splitY } = await splitSheetRows(sheetImageData);
  const hasRefs = !!(facePhoto || avatarFaces);
  const [headsR, bodiesR, identityR, poseHeads] = await Promise.all([
    evaluateSheetRow(topHeads, 'heads', { costumeDescription, model, promptOverride: promptOverrides.heads || null, usageTracker, glasses, hair }),
    // Bodies row (flash): feet / angles / outfit / proportions / background. It
    // does NOT judge head presence — a VLM hallucinates a head on a headless torso
    // (POPE-adversarial co-occurrence) — so the head axis is owned by pose
    // (detectBodyRowHeads) and merged in below. ONE source of truth per concept.
    evaluateSheetRow(bottomBody, 'bodies', { costumeDescription, costumeName, model, promptOverride: promptOverrides.bodies || null, usageTracker, declaredAge, glasses, hair }),
    hasRefs ? evaluateIdentity(topHeads, { sourcePhoto: facePhoto, avatarFaces, model, usageTracker, declaredAge, promptOverride: promptOverrides.identity || null }) : Promise.resolve(null),
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
 *                             style. The outfit is pass 1's axis and is not
 *                             re-judged here — pass 2 is a style transfer and
 *                             is never told which garments to draw. Style
 *                             transfer re-renders an
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
    declaredAge = null, model = null, promptOverrides = {}, usageTracker = null,
    imageLabels = null, glasses = null, hair = null,
  } = opts;
  // promptOverrides (Test Lab only) name the ONE judge template each replaces:
  // heads / bodies / identity on pass 1, style on pass 2. An override for a
  // judge this pass does not run is a mis-set experiment, not a no-op.
  const wanted = Number(pass) === 1 ? ['heads', 'bodies', 'identity'] : ['style'];
  const stray = Object.keys(promptOverrides || {}).filter(k => promptOverrides[k] && !wanted.includes(k));
  if (stray.length) throw new Error(`pass ${pass} has no ${stray.join('/')} judge to override (it runs: ${wanted.join(', ')})`);
  if (Number(pass) === 1) {
    const split = await evaluateSheetSplit(sheet, {
      facePhoto, standardAvatar, costumeDescription, costumeName, declaredAge, glasses, hair,
      model: model || MODEL_DEFAULTS.sheetEvalModel, promptOverrides: promptOverrides || {}, usageTracker,
    });
    return { verdict: split.verdict, split, promptUsed: split.promptUsed };
  }
  // The whole-sheet judge and the per-row cell checks are independent calls: started together, the
  // second is awaited inside the first's evaluator (a rejection there still surfaces from it).
  const rowObservations = observeStyledRows(sheet, { styleLabel: resolveStyleLineForSheet(artStyle), hair, model: model || MODEL_DEFAULTS.sheetEvalModel, usageTracker });
  rowObservations.catch(() => {});
  const styled = await evaluateStyledSheetWithGemini(
    facePhoto, realisticSheet, sheet, artStyle, process.env.GEMINI_API_KEY,
    usageTracker, declaredAge, { model: model || undefined, promptOverride: promptOverrides?.style || null, imageLabels, rowObservations }
  );
  return { verdict: styled.report, split: null, promptUsed: styled.promptUsed };
}

/**
 * Generate a 2×4 reference sheet for one character + costume in one Grok call.
 *
 * Inputs to Grok: phantom (pose template) + standard avatar (body / clothing
 * identity) + face photo (face identity). No Gemini styled-2×2 step — the 2×4
 * IS the styled avatar.
 *
 * Quality eval: pass 1 is reviewed row by row inside generateComposited2x4
 * (heads, bodies + pose head-check, identity); pass 2 by the style judge in
 * runStyleTransferPass. Both keep the least-bad attempt.
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
    // seasonOutfit = { season, label, outfit, footwear } from season.js
    // `seasonOutfitGuidance`, or null. Governs the GARMENTS the body cells wear
    // when nothing else states an outfit — the trial path, where the contract is
    // `signature: 'none'` and the sheet is the only thing that decides what the
    // child is wearing. Never touches identity; ignored on a redress sheet,
    // where the costume owns the outfit.
    seasonOutfit = null,
    // fastPass1 = the trial prewarm (decisions 2026-10-08, parallel rows replaced 2026-10-10): pass 1 draws the body row, then the head row against it, one
    // try each, and pass 2 restyles whatever comes back. The full-story path leaves it false: sequential rows, two tries each.
    fastPass1 = false,
    // A body row drawn ahead of the sheet by generateBodyRow (the trial draws it at the photo); stage 1 is skipped.
    precomputedBody = null,
    // Test Lab avatar_sheet_variant knobs (server/lib/testlab.js). Every default is the production value, so production calls
    // are unchanged; nothing but the Lab passes them (tests/unit/avatar-sheet-variant-options.test.ts pins the defaults).
    //   grokModel        the Grok tier of every call of the sheet (pass 1 rows and pass 2); undefined = Standard, resolved by the callee
    //   passTwoAttempts  total pass-2 attempts; undefined = 1 + MAX_SHEET_RETRIES, resolved by runStyleTransferPass
    //   styleAnchor      attach the per-style anchor image to pass 2 (default true)
    //   styledPass1      draw the rows straight in the art style and skip pass 2 (no photoreal pass at all)
    grokModel,
    passTwoAttempts,
    styleAnchor = true,
    styledPass1 = false,
  } = opts;
  if (styledPass1 && (!artStyle || artStyle === 'realistic')) throw new Error('styledPass1 needs a non-realistic art style');

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
      costumeDescription, costumeName, redress, usageTracker, skipReview: skipQualityEval, seasonOutfit,
      // fastPass1 = the trial prewarm: one try per row, so the row judges only record; they run beside the next render and pass 2 (see generateComposited2x4).
      precomputedBody, grokModel,
      ...(styledPass1 ? { styleLine: resolveStyleLineForSheet(artStyle) } : {}),
      ...(fastPass1 ? { rowTries: 1, deferJudges: true } : {}),
    });
  } catch (err) {
    throw new Error(`[CHARACTER 2×4] pass-1 generation failed for ${character?.name}: ${err.message}`);
  }
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
  const wantStyleTransfer = artStyle && artStyle !== 'realistic' && !styledPass1;
  // NO REALISTIC FALLBACK (owner, 2026-09-24). In a non-realistic story the
  // realistic Pass-1 sheet is never shipped as the character's avatar: that
  // child then looks unlike every other figure in the book. Three outcomes:
  //   - an attempt passes the style judge → ship it;
  //   - every attempt fails the style judge, at least one on a non-identity
  //     axis only → ship the higher-scoring of those WITH A WARNING (gates are
  //     guidelines: the final strike ships and says so);
  //   - no attempt produced pixels, or every one failed IDENTITY (a different
  //     person, or extra people painted in) → throw. A wrong person on every
  //     page is not a lesser version of the right avatar.
  // A throw here reaches convertAvatarToStyle, which records it in the styled-
  // avatar audit log the dev panel renders, then rethrows.
  let pass2 = null;
  if (wantStyleTransfer) {
    pass2 = await runStyleTransferPass({
      pass1ImageData: composed.imageData,
      facePhoto,
      artStyle,
      characterName: character?.name,
      characterAge: character?.age,
      hair: hairRequest(character),
      usageTracker,
      skipQualityEval,
      grokModel, maxAttempts: passTwoAttempts, useAnchor: styleAnchor,
    });
    if (!pass2.shippable) {
      const reasons = (pass2.finalVerdict?.failureReasons || []).join('; ') || 'no reason given';
      throw new Error(`[CHARACTER 2×4] ${character?.name} Pass 2: every styled attempt (${pass2.attempts?.length || 0}) failed IDENTITY (${pass2.identityFailing.join(', ')}; best score=${pass2.finalScore}/10: ${reasons}) — no styled sheet ships, and the realistic sheet is not a substitute`);
    }
  }

  // The pass-1 row judges (deferred in the trial prewarm) have had the whole of pass 2 to answer; their verdict is read only now.
  const { verdict, judgePrompts } = await composed.verdictPromise;
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
    judgePrompts: judgePrompts || null,
    sentToGrok: null,
  };

  // `styleJudgeRejected`: the shipped styled sheet was judged and failed the
  // style judge on a non-identity axis. It ships; the caller surfaces the
  // warning (styled-avatar audit entry + log).
  const styleJudgeRejected = !!pass2 && pass2.valid === false;
  const styleJudgeReasons = styleJudgeRejected ? (pass2.finalVerdict?.failureReasons || []) : [];
  const hardFailAxes = (pass2 && pass2.hardFailAxes) || [];
  if (styleJudgeRejected && hardFailAxes.length) {
    // SHIPPED BELOW THE BAR, LOUDLY (2026-10-09). Gates are guidelines, so the best
    // sheet still ships - but a sheet that hard-fails an axis after the extra,
    // fed-back attempt is an error somebody reads, and a counted one.
    log.error(`❌ [CHARACTER 2×4] ${character?.name} styled sheet SHIPPED BELOW THE BAR: ${hardFailAxes.join(', ')} at or below ${SHEET_HARD_FAIL_MAX}/10 after ${pass2.attempts?.length || 0} attempt(s)${pass2.extraAttempt ? ' (one extra attempt fed back the failed axis)' : ''}: ${styleJudgeReasons.join('; ') || 'no reason given'}`);
    try {
      const metrics = require('./runMetrics').forJob(require('./runMetrics').ambientJobId());
      metrics.count('avatar_sheet_shipped_hard_fail');
      for (const axis of hardFailAxes) metrics.count(`avatar_sheet_shipped_hard_fail_${axis}`);
    } catch { /* metrics are never fatal */ }
  }
  if (styleJudgeRejected) {
    log.warn(`⚠️ [CHARACTER 2×4] ${character?.name} Pass 2 failed the style judge on all ${pass2.attempts?.length || 0} attempt(s) — shipping the best styled attempt (#${pass2.selectedAttempt}, score=${pass2.finalScore}/10: ${styleJudgeReasons.join('; ') || 'no reason given'})`);
  }
  const shipped = pass2 || pass1;
  return {
    imageData: shipped.imageData,
    styleJudgeRejected,
    styleJudgeReasons,
    realisticImageData: pass1.imageData,
    usage: composed.usage,
    prompt: pass1.prompt,
    refs: {
      phantom: composed.refs?.phantom || null,
      standardAvatar: standardAvatar || null,
      facePhoto,
    },
    passes: { pass1, pass2 },
    // The styled (Pass 2) attempt history is what the dev panel renders.
    attemptHistory: pass2?.attempts || pass1.attempts,
    selectedAttempt: pass2?.selectedAttempt ?? pass1.selectedAttempt,
    // Score of the sheet that ACTUALLY SHIPPED — the styled one whenever Pass 2
    // ran, including a style-judge-rejected one shipped with a warning.
    finalScore: shipped.finalScore,
    finalVerdict: (pass2 ? pass2.finalVerdict : null) || pass1.finalVerdict,
  };
}

/**
 * Pass 2 — take the realistic Pass 1 sheet and re-render it in the story's
 * art style via Grok edit. Best-of-N retry. Eval via
 * evaluateStyledSheetWithGemini: layout + identity (vs source photo) +
 * style match. Returns the same shape as Pass 1's
 * collected fields so the dev panel can render both passes uniformly.
 */
async function runStyleTransferPass({ pass1ImageData, facePhoto, artStyle, characterName, characterAge = null, hair = null, usageTracker, promptOverride = null, backendOverride = null, skipQualityEval = false, grokModel, maxAttempts = 1 + MAX_SHEET_RETRIES, useAnchor = true }) {
  // Optional per-style anchor image (Image 2). The prompt references it only
  // when present; styleTransferGenerate passes it as the 2nd reference.
  const styleAnchor = useAnchor ? loadStyleAnchor(artStyle) : null;
  // promptOverride: Test Lab A/B — full replacement for the style-transfer
  // prompt (buildStyleTransferPrompt output), this call only.
  // TWO prompts, because the retry drops the anchor (see the loop below) and the
  // prompt must stop referring to an Image 2 that is no longer attached.
  const promptWithAnchor = promptOverride || buildStyleTransferPrompt(artStyle, { hasAnchor: !!styleAnchor });
  const promptNoAnchor = promptOverride || buildStyleTransferPrompt(artStyle, { hasAnchor: false });
  if (styleAnchor) log.info(`[CHARACTER 2×4] ${characterName} Pass 2 using style anchor (style-anchor-${artStyle})`);
  const totalAttempts = maxAttempts;
  // ONE extra, fed-back attempt when the best sheet so far hard-fails an axis
  // (SHEET_HARD_FAIL_MAX). The loop limit is raised once, at the last ordinary
  // attempt, and never again.
  let attemptLimit = totalAttempts;
  let feedbackLines = null;
  const attempts = [];
  // `best` = the highest-scoring attempt that may SHIP (identity not failed).
  // `bestIdentityRejected` = the highest-scoring attempt the judge rejected on
  // identity — never shipped, returned only so the dev panel / Test Lab can
  // show what came back.
  let best = null;
  let bestIdentityRejected = null;
  // The style judge's prompt (text only). It depends on the art style and age
  // alone, so one copy covers every attempt.
  let judgePrompt = null;
  // Unscored (null) ranks below any judged attempt, so a skipped or failed eval
  // can never win best-of-N by pretending to be a perfect score.
  const rank = (v) => (typeof v === 'number' ? v : -1);
  // Can this run act on a verdict at all? Both retries and the Gemini judge
  // are off in a trial, and both of the anchor-contamination defences below
  // hang off them — see the anchor comment in the loop.
  const canJudge = !!process.env.GEMINI_API_KEY && !skipQualityEval;

  const trackUsage = (result) => {
    if (usageTracker && result.usage) {
      // Image models are priced per image, not per token — without an explicit
      // cost the tracker falls into token-rate lookup, finds none for image
      // models, and poisons the run total with NaN (observed: $NaN TOTAL on
      // the 2026-07-21 run via gemini-3-pro style transfer).
      const usage = {
        ...result.usage,
        cost: result.usage.cost ?? require('../config/models').priceUsage(result.modelId, result.usage),
      };
      usageTracker(result.provider || 'grok', usage, 'character_2x4_style_transfer', result.modelId);
    }
  };

  for (let attempt = 1; attempt <= attemptLimit; attempt++) {
    // THE RETRY DROPS THE STYLE ANCHOR (2026-08-20). Every style-anchor-*.jpg
    // asset is a finished illustration of THREE PEOPLE on white — the same
    // shape as the sheet it is meant to restyle — so Grok sometimes blends the
    // anchor's figures into the output instead of taking only its brushwork.
    // Observed on staging job_1787252581387_6sn8z0nh2: an adult character's
    // sheet came back with the anchor's boy, woman and elderly man painted
    // across all 8 cells, scored 1/10 twice, and shipped. Re-sending the same
    // prompt with the same anchor just re-rolls the same dice; the retry has to
    // remove the contaminant to be worth paying for. Attempt 1 keeps the anchor
    // (it lifts style fidelity and is clean in the large majority of runs).
    // promptOverride is a Test Lab A/B: that run is measuring one exact prompt
    // against one exact reference set, so the anchor-drop stays off there —
    // changing the inputs under the experiment would corrupt its own result.
    //
    // AND THE ANCHOR IS NEVER ATTACHED WHEN NOTHING CAN JUDGE THE RESULT
    // (2026-09-07). Both defences — the identity/solo rejection (a sheet with
    // extra people never ships) and the anchor-dropping retry — key off the
    // Gemini verdict. A trial
    // passes skipQualityEval, so the loop breaks on attempt 1 with no verdict:
    // the dice are rolled once, with the contaminant attached, and whatever
    // comes back ships as the character's identity reference on every page.
    // That is staging job_1788763045123_z8so79ngb — Pass 1 was a clean 8-cell
    // sheet, Pass 2 came back as one merged crowd carrying the watercolor
    // anchor's boy, woman and elderly man, and each page then got a mis-cropped
    // slice of it (four pages a HEADLESS torso). Style fidelity is worth a
    // re-roll; it is not worth an unguarded one.
    const anchorForAttempt = promptOverride ? styleAnchor : ((attempt === 1 && canJudge) ? styleAnchor : null);
    const prompt = buildFedBackPrompt(anchorForAttempt ? promptWithAnchor : promptNoAnchor, attempt > totalAttempts ? feedbackLines : null);
    log.info(`[CHARACTER 2×4] ${characterName} Pass 2 (style=${artStyle}, backend=${MODEL_DEFAULTS.avatarStyleTransferBackend}) attempt ${attempt}/${attemptLimit}${attempt > totalAttempts ? ` (EXTRA, fed back: ${feedbackLines.map(l => l.split(':')[0]).join(', ')})` : ''}${styleAnchor && !anchorForAttempt ? (canJudge ? ' — anchor dropped after failed attempt' : ' — anchor dropped: nothing can judge or retry this sheet') : ''}`);
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
      result = await styleTransferGenerate(prompt, pass1ImageData, backendOverride, anchorForAttempt, grokModel);
    } catch (err) {
      log.warn(`[CHARACTER 2×4] ${characterName} Pass 2 attempt ${attempt}/${attemptLimit} (${MODEL_DEFAULTS.avatarStyleTransferBackend}) threw: ${err.message}${attempt < attemptLimit ? ' — retrying' : ''}`);
      attempts.push({ attempt, stage: 'gen-error', score: 0, reason: err.message, usedAnchor: !!anchorForAttempt });
      continue;
    }
    trackUsage(result);

    // STRUCTURAL CHECK ON THE STYLED SHEET — LOUD, NOT A GATE (2026-09-07).
    // Pass 1 has run quickLayoutCheck since the split-sheet bug; Pass 2 ran
    // nothing deterministic, so a sheet whose cells had merged into one crowd
    // shipped in silence (job_1788763045123_z8so79ngb). It is recorded and
    // log.error'd here so no such sheet is ever quiet again.
    //
    // It does NOT decide anything. docs/image-routing.md: quickLayoutCheck
    // measures gutter WHITENESS, so painterly styles false-positive on a
    // structurally correct sheet (measured: oil sheets at 25.3% and 57.4% were
    // fine) — "do NOT wire it as a hard gate on Pass-2 / styled sheets".
    // Making it decisive would ship realistic sheets into painted stories.
    // `layoutValid` rides the audit record; the ship/reject decision stays with
    // the Gemini styled-sheet eval, and the contamination itself is prevented
    // upstream by not attaching the anchor on an unjudgeable run.
    let layoutValid = true;
    try {
      const layout = await quickLayoutCheck(result.imageData);
      layoutValid = layout.valid !== false;
      if (!layoutValid) {
        log.error(`[CHARACTER 2×4] ${characterName} Pass 2 attempt ${attempt} FAILED the structural check — ${layout.reason}. The 2×4 grid may be gone; a merged sheet cannot serve as an identity reference. ADVISORY (painterly styles false-positive here) — the verdict below decides.`);
      }
    } catch (err) {
      // Unknown, never a pass — and never a reason to lose the style transfer.
      log.warn(`[CHARACTER 2×4] ${characterName} Pass 2 structural check threw: ${err.message} — layout unknown`);
      layoutValid = null;
    }

    // skipQualityEval covers pass 2 as well: the caller asked for no reviews
    // (trial has no repair stage and cannot act on a verdict), so accept the
    // first style transfer instead of scoring and retrying it.
    if (!process.env.GEMINI_API_KEY || skipQualityEval) {
      if (!process.env.GEMINI_API_KEY) log.warn('[CHARACTER 2×4] GEMINI_API_KEY missing — accepting Pass 2 after first attempt');
      // score null, NOT 10 — an unjudged style transfer must not be stored as a
      // perfect one (job_1788763045123_z8so79ngb shipped a corrupt sheet at 10/10
      // this way). `valid` below stays true, so the sheet still ships.
      best = { result, attempt, score: null, evaluated: false, verdict: null, prompt, layoutValid };
      attempts.push({ attempt, stage: skipQualityEval ? 'no-eval-requested' : 'no-eval-key', score: null, evaluated: false, imageData: result.imageData, sentToGrok: result.sentToGrok || null, usedAnchor: !!anchorForAttempt, layoutValid });
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
      ({ verdict, promptUsed: judgePrompt } = await evaluateAvatarSheet(result.imageData, {
        pass: 2, facePhoto, realisticSheet: pass1ImageData, artStyle, declaredAge: characterAge, hair, usageTracker,
      }));
      log.info(`[CHARACTER 2×4]   Pass 2 eval: layout=${verdict.layoutScore} identity=${verdict.identityScore} style=${verdict.styleScore} clean=${verdict.cleanScore} bodyFace=${verdict.bodyFaceScore} age=${verdict.ageScore ?? '-'} background=${verdict.backgroundScore ?? '-'} garment=${verdict.garmentScore ?? '-'} final=${verdict.finalScore} valid=${verdict.valid}`);
    } catch (err) {
      // A Gemini eval failure must NOT lock in this attempt and break the retry
      // loop. It is UNSCORED (null), so it ranks below every judged attempt: a
      // later attempt the judge actually saw — its identity verified — wins
      // (2026-09-24; it used to count as a neutral 5 and could beat a judged 4).
      log.warn(`[CHARACTER 2×4] Pass 2 eval error attempt ${attempt}: ${err.message} — unscored, continuing retries`);
      const candidate = { result, attempt, score: null, verdict: null, prompt, layoutValid };
      attempts.push({ attempt, stage: 'eval-error', score: null, evaluated: false, reason: err.message, imageData: result.imageData, sentToGrok: result.sentToGrok || null, usedAnchor: !!anchorForAttempt });
      if (!best || rank(candidate.score) > rank(best.score)) best = candidate;
      continue;
    }

    const score = verdict.finalScore ?? 0;
    // IDENTITY is the one axis a styled sheet may never fail and still ship
    // (owner, 2026-09-24): a sheet showing a different person (identity) or
    // extra people (solo — the style anchor's figures painted in) is a wrong
    // person on every page. Every other axis is a quality gate that ships with
    // a warning on the final strike.
    const identityFailing = STYLED_IDENTITY_AXES
      .filter(n => typeof verdict[`${n}Score`] === 'number' && verdict[`${n}Score`] < SHEET_VALID_MIN);
    attempts.push({
      attempt,
      stage: verdict.valid ? 'valid' : 'invalid',
      score,
      layoutScore: verdict.layoutScore,
      identityScore: verdict.identityScore,
      styleScore: verdict.styleScore,
      cleanScore: verdict.cleanScore,
      bodyFaceScore: verdict.bodyFaceScore,
      ageScore: verdict.ageScore,
      soloScore: verdict.soloScore,
      backgroundScore: verdict.backgroundScore,
      garmentScore: verdict.garmentScore,
      hairScore: verdict.hairScore,
      reasons: verdict.failureReasons || [],
      imageData: result.imageData,
      sentToGrok: result.sentToGrok || null,
      usedAnchor: !!anchorForAttempt,
      layoutValid,
      identityRejected: identityFailing.length > 0,
      ...(attempt > totalAttempts ? { extraAttempt: true, fedBack: feedbackLines } : {}),
    });
    const candidate = { result, attempt, score, verdict, prompt, layoutValid, identityFailing };
    if (identityFailing.length) {
      if (!bestIdentityRejected || rank(candidate.score) > rank(bestIdentityRejected.score)) bestIdentityRejected = candidate;
    } else if (!best || rank(candidate.score) > rank(best.score)) {
      best = candidate;
    }
    if (verdict.valid) break;
    log.warn(`[CHARACTER 2×4] ${characterName} Pass 2 attempt ${attempt} score=${score} (valid=false${identityFailing.length ? `, IDENTITY failed: ${identityFailing.join(', ')}` : ''})`);
    // THE LAST ORDINARY ATTEMPT FAILED: if the sheet that would ship hard-fails an
    // axis, buy ONE more attempt that names that axis (decisions 2026-10-09).
    // Never on a Test Lab prompt A/B (that run measures one exact prompt).
    if (attempt === totalAttempts && attemptLimit === totalAttempts && !promptOverride) {
      const shipping = best || bestIdentityRejected;
      const lines = hardFailFeedback(shipping?.verdict, { hair });
      if (lines.length) {
        feedbackLines = lines;
        attemptLimit = totalAttempts + 1;
      }
    }
  }

  // A sheet whose two rows disagree on garment colour is caught by the STYLE
  // EVAL, not by arithmetic here (owner, 2026-08-15): prompts/sheet-2x4-style-eval.txt
  // task 3 scores partial style transfer 4-6, and task 4 requires the same
  // colours across cells. A colour-only mechanism used to duplicate that check
  // and force its own retry; it was removed because it could not separate a
  // pale garment (chroma 9.8) from JPEG speckle on the white backdrop (4-8),
  // and both of its failure modes still measured "rows agree".
  // Every attempt threw before producing pixels: no styled sheet exists, and the
  // caller lets this propagate — the realistic Pass-1 sheet is never shipped in
  // its place (owner, 2026-09-24).
  if (!best && !bestIdentityRejected) throw new Error(`[CHARACTER 2×4] ${characterName} Pass 2 produced no image in ${totalAttempts} attempt(s)`);

  // `shippable` is false only when EVERY attempt that produced pixels failed
  // identity. The caller then fails loudly — there is no realistic Pass-1
  // substitute (owner, 2026-09-24). The rejected sheet is still returned so the
  // dev panel and Test Lab can show it.
  const shippable = !!best;
  const chosen = best || bestIdentityRejected;
  // `valid` is the style judge's verdict on the chosen sheet. False = judged
  // and rejected on a non-identity axis: the caller SHIPS it with a warning.
  // The unjudgeable paths (skipQualityEval, no Gemini key, eval threw) carry a
  // null verdict and stay valid — the trial must never lose its styled sheet
  // to an eval outage.
  const valid = chosen.verdict ? chosen.verdict.valid !== false : true;
  // The axes of the sheet that SHIPS that are still at or below the hard-fail
  // line after every attempt, extra one included. The caller makes it loud.
  const hardFailAxes = (!valid && chosen.verdict)
    ? hardFailFeedback(chosen.verdict, { hair }).map(l => l.split(':')[0])
    : [];

  return {
    imageData: chosen.result.imageData,
    shippable,
    hardFailAxes,
    extraAttempt: feedbackLines != null && attempts.some(a => a.extraAttempt),
    identityFailing: shippable ? [] : chosen.identityFailing,
    valid,
    selectedAttempt: chosen.attempt,
    finalScore: chosen.score,
    finalVerdict: chosen.verdict,
    // Echo the backend/model that actually produced the winning sheet, so
    // callers (Test Lab) record the true model per result instead of a label.
    provider: chosen.result.provider || null,
    modelId: chosen.result.modelId || null,
    attempts,
    // The winning attempt's own prompt — attempt 2 drops the anchor, so the two
    // attempts no longer share one prompt string.
    prompt: chosen.prompt,
    judgePrompt,
    sentToGrok: chosen.result.sentToGrok || null,
  };
}

/**
 * WARDROBE-STATE VARIANT — the approved sheet, redressed.
 *
 * Takes the character's ALREADY-APPROVED styled 2×4 sheet and edits the named
 * garments off it. The input is the approved sheet and not the photos, and that
 * is the whole design (owner, 2026-09-19): two independent photo→sheet runs
 * disagree on hair, build and base-layer shade, so a jacket coming off would
 * read as the CHARACTER changing — a worse failure than the one being fixed.
 * Identity is fixed by construction here; only the wardrobe varies. Same shape
 * as the costumed-vs-standard sheet swap the pipeline already ships.
 *
 * Mechanically this is Pass 2's machinery (one provider edit on a whole sheet,
 * best-of-N) with a different instruction, so it inherits the aspect handling
 * and the crop suppression the sheet grid needs. The STYLE ANCHOR is never
 * attached: the input is already in the story's style, and the anchor's own
 * figures are a known contaminant.
 *
 * THE GATE IS THE JUDGE THAT APPROVED THE BASE SHEET (owner, 2026-10-04): the
 * Pass-2 style judge, shown the base's own Pass-1 realistic sheet as Image 2 —
 * exactly the inputs that approved the base — plus one garment-gone check per
 * garment taken off (evaluateVariantSheet; GARMENT_OFF_SHEET_RULE is also
 * stated to the generator). It used to
 * be evaluateSheetSplit, the Pass-1 row judges: absolute crop and outfit scores
 * the approved base itself fails (staging job_1791040103540_atbttop6w, Kiaan's
 * base sheet 1/10 on crop, outfit and "costumeReads"), so every redress, which
 * inherits the base layout, was rejected and no off-garment sheet was stored
 * after ~2026-09-26. The earlier worry that a style judge "rejects every
 * redress" held for a styled base as Image 2 (style applied? no change), not
 * for the realistic Pass-1 sheet it is given here.
 *
 * No Pass-1 sheet or no face photo for the base = nothing to judge against:
 * NO variant, logged as an error (the page then records the missing sheet).
 *
 * Returns null before any paid edit when an input is missing. When every
 * attempt is rejected it returns {imageData: null, accepted: false, attempts}
 * so the gate's answers are recorded. The caller then stores no
 * variant; the page renders with the worn sheet and records a shipped defect.
 *
 * @param {string} baseSheetImageData - the approved styled 2×4 sheet
 * @param {Object} opts
 * @param {string} opts.characterName
 * @param {Array<string>} opts.removedItems - the garment names being taken off (logging only)
 * @param {string} opts.authoredWardrobe - the Art Director's wardrobe instruction; required
 * @param {string} opts.realisticSheet - the base sheet's own Pass-1 realistic sheet (the style judge's Image 2); required
 * @param {string} opts.facePhoto - the source face photo (the style judge's Image 1); required
 * @param {string} opts.artStyle - the story's art style
 * @returns {Promise<{imageData, verdict, attempts, prompt}|null>}
 */
/**
 * THE REDRESS PROMPT = the Art Director's wardrobe half + this sheet-mechanics
 * scaffold. Nothing here words a wardrobe.
 *
 * Owner, 2026-09-19: "The AD should create the full prompt that is needed to
 * strip the avatar later." The Art Director holds the outfit contract, the
 * garment, the slot, the page and the exact off-combination, so it writes which
 * garments stay (named briefly — colour plus garment noun, never the contract's
 * own fabric/cut adjectives, which measurably made the provider repaint a
 * garment it was told to leave alone), which comes off, and what the removal
 * leaves outermost (described in full: it has to be DRAWN, and in the
 * turned-away cells the sheet has never shown it).
 *
 * This function owns only what is identical for every character in every story:
 * that the image is a 2×4 of 8 cells, that Image 1 — not the words — is the
 * authority for how a kept garment looks, the front-vs-back drawing
 * instruction, and the identity invariants. The Art Director is told none of
 * that and must not write it.
 *
 * THERE IS NO DERIVATION (owner, 2026-09-19). A mechanical stripper used to
 * word this half from the contract and was DELETED, not demoted: two
 * implementations of one instruction drift, and the weaker one hides the
 * stronger one's failures — a page whose brief authored nothing shipped a
 * quietly worse sheet instead of showing the gap. Called without an authored
 * half this throws; the caller then builds no variant at all, and the page
 * keeps the pre-feature behaviour (the worn sheet plus the "is NOT wearing"
 * text line). An absent sheet is not a fallback implementation.
 */
function buildRedressPrompt(authoredWardrobe, removedGarments = []) {
  const wardrobeHalf = String(authoredWardrobe || '').trim();
  const removed = (Array.isArray(removedGarments) ? removedGarments : []).map(s => String(s || '').trim()).filter(Boolean);
  if (!wardrobeHalf) {
    throw new Error('[WARDROBE-VARIANT] no authored wardrobe instruction — nothing else writes one');
  }
  return `Edit Image 1 — a 2×4 character reference sheet (8 cells).
${wardrobeHalf}
${removed.length ? `Taken off: ${removed.join('; ')}. ${GARMENT_OFF_SHEET_RULE}\n` : ''}Image 1 is the only authority for how anything the character keeps on looks — its colour, cut, fabric and weave: copy them, do not redraw them from words.
Draw every garment right round the body: in a cell facing the viewer its front, in a cell turned away its back — which this sheet has never shown, so draw it rather than uncover it.
Change nothing else. Same character, same face, same hair, same body, same poses, same cell layout, same art style.`;
}

/**
 * One attempt's gate answer, in the shape stored on the variant's log entry
 * (styledAvatarGeneration): the style verdict, then every per-garment question
 * with its answer. Text and numbers only, never an image.
 */
function gateRecordOf(verdict) {
  const style = verdict?.styleGate || { finalScore: verdict?.finalScore ?? null, valid: verdict?.valid ?? null, failureReasons: verdict?.failureReasons || [] };
  return {
    style: { score: style.finalScore ?? null, valid: style.valid ?? null, reasons: style.failureReasons || [] },
    garmentChecks: (verdict?.garmentChecks || []).map(c => ({
      garment: c.garment, question: c.question || null, visible: c.visible, cells: c.cells || '', reason: c.reason || '',
    })),
    removedScore: verdict?.removedScore ?? null,
    // The garments that must stay: each question and answer, or why none ran.
    keptChecks: (verdict?.keptChecks || []).map(c => ({
      garment: c.garment, question: c.question || null, visible: c.visible, cells: c.cells || '', reason: c.reason || '',
    })),
    keptCheckSkipped: verdict?.keptCheckSkipped || null,
    keptScore: verdict?.keptScore ?? null,
    finalScore: verdict?.finalScore ?? null,
    valid: verdict?.valid ?? null,
  };
}

async function redressSheetVariant(baseSheetImageData, opts = {}) {
  const {
    characterName = 'character', characterAge = null, facePhoto = null,
    removedItems = [], usageTracker = null, skipQualityEval = false,
    backendOverride = null, authoredWardrobe = null, realisticSheet = null, artStyle = null,
    keptGarments = null, keptCheckSkipped = null,
  } = opts;
  if (!baseSheetImageData) return null;

  const items = (Array.isArray(removedItems) ? removedItems : []).map(s => String(s || '').trim()).filter(Boolean);
  const wardrobeHalf = String(authoredWardrobe || '').trim();
  if (!wardrobeHalf) {
    log.error(`[WARDROBE-VARIANT] ${characterName}: no authored wardrobe instruction (off: ${items.join(', ') || 'unknown'}) — NO variant sheet. Nothing else writes this instruction.`);
    return null;
  }
  const judged = !skipQualityEval && !!process.env.GEMINI_API_KEY;
  if (judged && (!realisticSheet || !facePhoto)) {
    log.error(`[WARDROBE-VARIANT] ${characterName}: the base sheet's ${!realisticSheet ? 'Pass-1 realistic sheet' : 'face photo'} is not available — the style judge that approved the base cannot judge the variant. NO variant sheet.`);
    return null;
  }
  if (judged && !(Array.isArray(keptGarments) && keptGarments.length) && !keptCheckSkipped) {
    log.error(`[WARDROBE-VARIANT] ${characterName}: no kept-garment list and no reason for skipping the kept check — NO variant sheet (checked before any paid edit).`);
    return null;
  }
  const prompt = buildRedressPrompt(wardrobeHalf, items);

  const totalAttempts = 1 + MAX_SHEET_RETRIES;
  const attempts = [];
  let best = null;
  const rank = (v) => (typeof v === 'number' ? v : -1);

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    log.info(`[WARDROBE-VARIANT] ${characterName} redress attempt ${attempt}/${totalAttempts} (off: ${items.join(', ')})`);
    let result;
    try {
      // No style anchor: the input sheet already carries the story's style.
      result = await styleTransferGenerate(prompt, baseSheetImageData, backendOverride, null);
    } catch (err) {
      log.warn(`[WARDROBE-VARIANT] ${characterName} redress attempt ${attempt} threw: ${err.message}${attempt < totalAttempts ? ' — retrying' : ''}`);
      attempts.push({ attempt, stage: 'gen-error', score: 0, reason: err.message });
      continue;
    }
    if (usageTracker && result.usage) {
      usageTracker(result.provider || 'grok', {
        ...result.usage,
        cost: result.usage.cost ?? require('../config/models').priceUsage(result.modelId, result.usage),
      }, 'character_2x4_wardrobe_variant', result.modelId);
    }
    if (!result?.imageData) {
      attempts.push({ attempt, stage: 'no-image', score: 0, reason: 'provider returned no image' });
      continue;
    }

    if (!judged) {
      // Nothing can judge it; one roll, shipped, and said so.
      log.warn(`[WARDROBE-VARIANT] ${characterName} redress shipped UNSCORED (${skipQualityEval ? 'eval skipped by caller' : 'no GEMINI_API_KEY'})`);
      return { imageData: result.imageData, accepted: true, verdict: null, attempts, prompt };
    }

    let verdict = null;
    try {
      ({ verdict } = await evaluateVariantSheet(result.imageData, {
        facePhoto, realisticSheet, artStyle, declaredAge: characterAge, usageTracker,
        removedGarments: items, keptGarments, keptCheckSkipped,
      }));
    } catch (err) {
      log.error(`[WARDROBE-VARIANT] ${characterName} redress eval threw: ${err.message} — attempt rejected, never shipped unchecked`);
      attempts.push({ attempt, stage: 'eval-error', score: null, reason: err.message });
      continue;
    }
    attempts.push({ attempt, stage: 'judged', score: verdict.finalScore, valid: verdict.valid, accepted: verdict.valid === true, reason: (verdict.failureReasons || []).join('; ') || null, gate: gateRecordOf(verdict) });
    if (!best || rank(verdict.finalScore) > rank(best.score)) {
      best = { imageData: result.imageData, verdict, score: verdict.finalScore };
    }
    if (verdict.valid) {
      log.info(`[WARDROBE-VARIANT] ${characterName} redress accepted (score=${verdict.finalScore}/10, removed=${verdict.removedScore}/10)`);
      return { imageData: result.imageData, accepted: true, verdict, attempts, prompt };
    }
  }

  const why = (best?.verdict?.failureReasons || []).join('; ') || 'no attempt produced a usable sheet';
  log.error(`[WARDROBE-VARIANT] ${characterName} redress REJECTED after ${attempts.length} attempt(s) (best=${best?.score ?? 'unscored'}/10: ${why}) — no variant stored; every page that takes ${items.join(', ')} off records a missing off sheet`);
  // No image: the caller stores no variant. The record is returned so the gate's
  // answers reach the story's diagnostics instead of dying in the log.
  return { imageData: null, accepted: false, verdict: best?.verdict || null, attempts, prompt };
}

module.exports = {
  generateCharacter2x4Sheet,
  generateBodyRow,
  generateOneCallSheet,
  buildOneCallSheetPrompt,
  styleBodyRow,
  phantomTierForAge,
  redressSheetVariant,
  gateRecordOf,
  buildRedressPrompt,
  GARMENT_OFF_SHEET_RULE,
  checkGarmentGone,
  checkKeptGarment,
  evaluateVariantSheet,
  // Exported for tests: the declared-age proportion block must reach the prompt.
  declaredAgeBlock,
  buildBodyRowPrompt,
  buildHeadRowPrompt,
  buildGlassesBlock,
  // Standalone Pass 2 (style transfer from an existing realistic sheet) +
  // face-photo resolver — used by Test Lab to reuse one realistic anchor
  // across many style transfers.
  runStyleTransferPass,
  resolveFacePhoto,
  buildStyleTransferPrompt,
  // exposed for tests
  readAvatarHair,
  _internal: { generateComposited2x4, SHEET_HARD_FAIL_MAX, hardFailFeedback, buildFedBackPrompt, stampVerdict, sheetStackPad, stackRowsInto2x4, mergeRowObservations, observeStyledRow, hairRequest, headRowCropFraction, cropHeadRowToShoulders, applyRowConsistencyAxes, applyStyledSheetConsistencyAxes, TAIL_POSE_RULE, applyGlassesAxis, applyPoseHeadGate, detectBodyRowHeads, detectSheetRowDivider, parseJudgeJson, buildBodyRowPrompt, buildHeadRowPrompt, buildFootwearRule, buildGarmentRule, buildSeasonOutfitBlock, buildStyleTransferPrompt, resolveFacePhoto, resolveStandardAvatar, quickLayoutCheck, evaluateStyledSheetWithGemini, runStyleTransferPass, splitSheetRows, evaluateSheetRow, evaluateIdentity, evaluateSheetSplit, evaluateAvatarSheet, isEchoedJudgeVerdict, REAR_TURN_POSE, SHEET_GROUND_RULE, SHEET_NO_LETTERING_RULE, CELL_NAMES_NOT_DRAWN, garmentColourRule, buildUnnamedTrimRule, scoreHeadsReport, scoreStyleReport, scoreIdentityReport },
};
