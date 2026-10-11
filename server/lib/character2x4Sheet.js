/**
 * Character 2×4 reference sheet: the prompt blocks, the ONE Grok 2.0 call that draws a sheet (generateOneCallSheet), the wardrobe-variant
 * edit of an approved sheet (redressSheetVariant) and the pass-2 style judge that gates such an edit.
 *
 * One 8-cell sheet per character per costume:
 *   - Top row (cells 1–4): head and shoulders, front / 45° / profile / rear turn
 *   - Bottom row (cells 5–8): full body at the same four angles
 *
 * Every sheet (standard and costume, trial and full story) is ONE call on MODEL_DEFAULTS.avatarSheetModel from the face photo (and the body
 * cut-out), drawn straight in the story's art style (docs/decisions.md 2026-10-10 "avatar sheets are ONE Grok 2 call"). oneCallSheet.js
 * wraps it in the sheet check (avatarSheetJudge: one judge, one redo, recorded). The row chain this file used to hold (body row, head row,
 * pass 2, the row judges) was deleted there; git history has it.
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
const r2 = require('./r2');
const { getFacePhoto } = require('./characterPhotos');
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

// Nearest supported aspect preset for an image, so an edit OUTPUTS the same shape as its input instead of squeezing it
// (Gemini/Grok only take preset strings). The wardrobe-variant edit of an approved sheet uses it.
async function aspectPresetFor(imageData) {
  try {
    const buf = Buffer.from(r2.stripDataUriPrefix(imageData), 'base64');
    const { width, height } = await sharp(buf).metadata();
    const r = width / height;
    const presets = [['1:1', 1], ['3:4', 0.75], ['4:3', 4 / 3], ['9:16', 0.5625], ['16:9', 16 / 9]];
    return presets.reduce((best, p) => Math.abs(p[1] - r) < Math.abs(best[1] - r) ? p : best)[0];
  } catch { return '16:9'; }
}

// The edit call of redressSheetVariant (an approved sheet in, the same sheet with the outfit changed out). `backendOverride`
// ('gemini' | 'grok') bypasses MODEL_DEFAULTS for ONE call. Model IDs never cross providers: each branch resolves its own.
async function styleTransferGenerate(prompt, sheetImageData, backendOverride = null) {
  const backend = backendOverride || MODEL_DEFAULTS.avatarStyleTransferBackend;
  const aspectRatio = await aspectPresetFor(sheetImageData); // the output keeps the sheet's shape
  const refs = [sheetImageData];
  if (backend === 'gemini') {
    const r = await editWithGeminiImage(prompt, refs, { aspectRatio, model: MODEL_DEFAULTS.avatarStyleTransferModel });
    return { ...r, provider: 'gemini_image' };
  }
  // skipOutputCrop: the sheet is a panel GRID that gets split into cells. A
  // drift crop trims whole rows/columns off the edges — i.e. it eats panels.
  const r = await editWithGrok(prompt, refs, { aspectRatio, model: GROK_MODELS.STANDARD, skipOutputCrop: true });
  return { ...r, provider: 'grok' };
}

// Best-of-N cap of the wardrobe-variant edit: first attempt + N retries (max 1 retry, user direction 2026-08-09).
const MAX_SHEET_RETRIES = 1;

// The cell-4 / cell-8 pose, ONE definition. The sheet generator and every sheet judge fill it from
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
const SHEET_NO_LETTERING_RULE = 'The sheet is pictures only: the paper around every figure stays blank, with no caption, label, word, letter or number in or between the cells. A label naming a cell or a view (front, profile, …) is a caption too.';
// Row generators name the cells (front, three-quarter, …); those names are
// what the model printed. Generator-only: judges never see the cell names.
// A figure whose lower body is a tail or fin, ONE definition: the body-row generator states it and
// the bodies judge scores it (filled as {TAIL_POSE}). Staging job_1791315635053_t0t8qpebu: Emma's
// costumed mermaid sheet stood upright on a flat fin, and pages 8 and 10 drew her standing on her
// fin on a hard floor.
const TAIL_POSE_RULE = 'A figure whose lower body is a tail or fin never stands on it: the figure sits on the ground with the torso upright, the tail curved out along the ground in a gentle S and the fin lying flat on the ground beside it, never balanced upright on the fin like a pair of feet.';

const CELL_NAMES_NOT_DRAWN = 'The cell names here say which way each figure faces; they are never written on the sheet.';

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

// Head-to-standing-height norms of the Lab costume-sheet measurement (docs/decisions.md 2026-10-10 "Trial costume sheet: two fast
// options measured"): the owner's brief (2-3 y 1/4, 5-6 y 1/5, 9-10 y 1/6, adult 1/7-7.5), the gaps interpolated, cross-checked
// against the head-height table of getAgeMarkers. ONE table: the one-call prompt line and the Lab's measurement both read it.
function headFractionNorm(age) {
  const a = parseInt(age, 10);
  if (!Number.isFinite(a) || a < 0) return null;
  if (a <= 3) return 4;
  if (a === 4) return 4.5;
  if (a <= 6) return 5;
  if (a <= 8) return 5.5;
  if (a <= 10) return 6;
  if (a <= 12) return 6.5;
  if (a <= 17) return 7;
  return 7.25;
}

/** The explicit head-to-height proportions line of the sheet prompt (docs/decisions.md 2026-10-10 "Trial costume sheet: two fast options measured"). */
function ageProportionsLine(character) {
  const n = headFractionNorm(character?.age ?? character?.declaredAge);
  if (!n) return '';
  return ` Head size: in every full-body cell the head is about 1/${n} of the figure's standing height (a ${n}-head figure), with long legs and the build of a real ${parseInt(character.age ?? character.declaredAge, 10) >= 18 ? 'adult' : 'child of that age'}: not chibi, not doll-like, not a big-head cartoon.`;
}

// ── THE avatar sheet: the whole styled 2×4 from the photo in ONE call (docs/decisions.md 2026-10-10 "avatar sheets are ONE Grok 2 call") ──
// Built from the rule constants and prompt blocks the removed row prompts used. Layout guide = the axes phantom's head row over the plain
// phantom's body row. The call is on MODEL_DEFAULTS.avatarSheetModel. `hasReference`: Image 3 is the character's existing body/clothing
// reference (the wizard avatar, or the trial's body cut-out); a standard sheet takes its clothes from it, a costume sheet ignores them.
function buildOneCallSheetPrompt(character, { costumeDescription, costumeName = null, seasonOutfit = null, styleLine, kind, hasReference = false, redoLines = [] }) {
  if (kind !== 'standard' && kind !== 'costume') throw new Error(`buildOneCallSheetPrompt: kind must be standard | costume, got "${kind}"`);
  const named = costumeName ? ` — a ${costumeName}` : '';
  // A costume sheet is dressed from the costume text alone: it owns the footwear and the trim, and takes no season.
  const costumeOwnsOutfit = kind === 'costume';
  const declaredAge = declaredAgeBlock(character);
  const ageFromPhoto = declaredAge ? '' : " matching the person's apparent age in Image 2";
  const proportionsRule = (declaredAge ? declaredAge.trimStart() : "Body proportions match the person's apparent age (an adult is roughly 7 to 8 heads tall).")
    + ageProportionsLine(character);
  const referenceBlock = hasReference
    ? (kind === 'standard'
      ? "\nImage 3 is the person's body reference: take its CLOTHING and build only. Whatever the person holds or carries in Image 3 (a hoop, ball or toy, a backpack or bag) is NOT part of the character."
      : "\nImage 3 is the person's body reference: take its build only. IGNORE its clothing, it is the wrong outfit.")
    : '';
  const redo = redoLines.length ? `\nCORRECTIONS to the previous attempt (fix all of them, change nothing else):\n${redoLines.map(l => `- ${l}`).join('\n')}` : '';
  return `Image 1 is a layout guide ONLY: a 2×4 grid (two rows of four cells) showing the camera angle and facing direction of each cell. Ignore its silhouettes, bodies and faces. The output contains no arrows.
Image 2 is the character's face photo — the identity; match this exact face.${referenceBlock}

Output ONE image: a 2×4 grid, thin dividers between the cells, pure white background, the same layout as Image 1. Every cell shows the SAME PERSON as Image 2, alone, in the same art style, wearing the same costume.
TOP ROW (4 cells): head, neck and the top of the shoulders, cut off at the upper chest, with plain white above the hair; never crop the top of the head. BOTTOM ROW (4 cells): the COMPLETE FULL BODY from the very top of the head to the figure's lowest point (normally both feet with shoes), the whole figure inside its cell; if it does not fit, scale it down with white margin above and below. ${proportionsRule}
In both rows: cell 1 front, cell 2 three-quarter, cell 3 profile, cell 4 a REAR TURN: ${REAR_TURN_POSE}. Cell 4 is never a second profile and never a flat back view with no face showing.

Costume${named}: ${costumeDescription}${buildSeasonOutfitBlock(seasonOutfit, costumeOwnsOutfit)}${buildHairBlock(character)}${buildGlassesBlock(character)}
Art style: ${styleLine}${ageFromPhoto ? `. Natural proportions${ageFromPhoto}` : ''}. The face, hair colour and skin tone stay recognisably the person in Image 2.
${buildFootwearRule(costumeOwnsOutfit, seasonOutfit?.footwear)}
Where the costume replaces the legs (a tail, a fin, a single fused lower body) the figure has no legs, no feet and no footwear: it ends at the tip of that form, which is then the lowest point. ${TAIL_POSE_RULE}
${buildGarmentRule()}
${SHEET_EMPTY_HANDS_RULE}
The outfit is identical in all eight cells, layers included, and the neckline in the top row is the one the body below wears. ${buildUnnamedTrimRule(costumeOwnsOutfit)} ${SHEET_GROUND_RULE} ${SHEET_NO_LETTERING_RULE} ${CELL_NAMES_NOT_DRAWN}${redo}`;
}

/**
 * ONE Grok call: photo (+ optional body reference) -> the styled 2×4 sheet. No judge here; oneCallSheet.js owns judge, redo and record.
 * `references`: 'face' = the face photo only; 'face+body' = also the character's body cut-out (photos.bodyNoBg, else photos.body); the A/B that chose it is in docs/decisions.md 2026-10-10.
 * `grokModel` defaults to MODEL_DEFAULTS.avatarSheetModel (the Lab may name another tier).
 */
async function generateOneCallSheet(character, { artStyle, kind, costumeDescription = 'standard outfit', costumeName = null, seasonOutfit = null, usageTracker = null, grokModel = MODEL_DEFAULTS.avatarSheetModel, references = MODEL_DEFAULTS.avatarSheetReferences, redoLines = [] } = {}) {
  if (!artStyle || artStyle === 'realistic') throw new Error('generateOneCallSheet: a non-realistic art style is required');
  if (references !== 'face' && references !== 'face+body') throw new Error(`generateOneCallSheet: references must be face | face+body, got "${references}"`);
  const facePhoto = await resolveFacePhoto(character);
  if (!facePhoto) throw new Error(`No face photo for ${character?.name || 'character'}.`);
  const reference = references === 'face+body' ? await resolveBodyReference(character) : null;
  if (references === 'face+body' && !reference) throw new Error(`generateOneCallSheet: ${character?.name || 'character'} has no body photo for references=face+body`);
  const head = Buffer.from(r2.stripDataUriPrefix(await phantomRow(loadPhantomVariant(character?.age, 'axes'), 'top')), 'base64');
  const body = Buffer.from(r2.stripDataUriPrefix(await phantomRow(loadPhantomVariant(character?.age, 'plain'), 'bottom')), 'base64');
  const W = (await sharp(body).metadata()).width;
  const headFit = await sharp(head).resize({ width: W }).png().toBuffer();
  const hH = (await sharp(headFit).metadata()).height;
  const bH = (await sharp(body).metadata()).height;
  const guide = await sharp({ create: { width: W, height: hH + bH, channels: 3, background: '#ffffff' } })
    .composite([{ input: headFit, top: 0, left: 0 }, { input: body, top: hH, left: 0 }]).png().toBuffer();
  const prompt = buildOneCallSheetPrompt(character, { costumeDescription, costumeName, seasonOutfit, styleLine: resolveStyleLineForSheet(artStyle), kind, hasReference: !!reference, redoLines });
  const refs = [`data:image/png;base64,${guide.toString('base64')}`, facePhoto, ...(reference ? [reference] : [])];
  const res = await editWithGrok(prompt, refs, { aspectRatio: '1:1', model: grokModel, skipOutputCrop: true });
  if (!res?.imageData) throw new Error(`generateOneCallSheet: no image for ${character?.name}`);
  if (usageTracker && res.usage) usageTracker('grok', res.usage, 'character_2x4_one_call', res.modelId);
  return { imageData: res.imageData, usage: res.usage, modelId: res.modelId || grokModel, prompt };
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

/** The character's body cut-out (photos.bodyNoBg, else photos.body) as a data URI, or null: Image 3 of the sheet call. */
async function resolveBodyReference(character) {
  const candidate = character?.photos?.bodyNoBg || character?.photos?.body;
  if (!candidate) return null;
  const bytes = await r2.bytesFromAnyImage(candidate);
  return bytes ? `data:image/jpeg;base64,${bytes.toString('base64')}` : null;
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
 * THE VARIANT GATE (docs/decisions.md 2026-10-10 "avatar sheets are ONE Grok 2 call"): the ONE sheet judge (avatarSheetJudge: bald or
 * headless cell, held object, broken layout, tail) on the edited sheet, plus one garment-gone check per removed garment and one
 * kept-garment check per garment that must stay. It passes only when the sheet judge flags nothing and every check agrees. The
 * pass-2 style judge that used to gate a variant needed the photoreal pass-1 sheet as its Image 2; no such sheet exists any more, and
 * a styled base as Image 2 rejected every redress (decisions 2026-10-04), so it is gone with the pass.
 * A judge or check that cannot answer THROWS: the caller rejects the attempt, a variant is never shipped unchecked.
 */
async function evaluateVariantSheet(sheet, opts = {}) {
  const { removedGarments = [], keptGarments = null, keptCheckSkipped = null, usageTracker = null } = opts;
  const names = (Array.isArray(removedGarments) ? removedGarments : []).map(s => String(s || '').trim()).filter(Boolean);
  // The kept list is required unless the caller says why no kept check runs
  // (an outfit version authors none): a variant is never gated on half the question.
  const kept = Array.isArray(keptGarments) ? keptGarments : [];
  if (!kept.length && !keptCheckSkipped) throw new Error('evaluateVariantSheet: no keptGarments and no keptCheckSkipped reason');
  const { judgeAvatarSheet, sheetDefects } = require('./avatarSheetJudge');
  const [judged, checks, keptChecks] = await Promise.all([
    judgeAvatarSheet({ sheet, kind: 'costume', model: MODEL_DEFAULTS.sheetEvalModel, usageTracker }),
    Promise.all(names.map(g => checkGarmentGone(sheet, g, { usageTracker }))),
    Promise.all(kept.map(g => checkKeptGarment(sheet, g, { usageTracker }))),
  ]);
  const sheetFlags = sheetDefects(judged.parsed);
  const still = checks.filter(c => c.visible);
  const missing = keptChecks.filter(c => !c.visible);
  const failureReasons = [
    ...sheetFlags.map(d => `sheet: ${d.type}/${d.word}${d.cells.length ? ` in cell(s) ${d.cells.join(', ')}` : ''}`),
    ...still.map(c => `removed: ${c.garment} is still visible — ${c.reason}`),
    ...missing.map(c => `kept: ${c.garment} is missing from the body cells — ${c.reason}`),
  ];
  const valid = failureReasons.length === 0;
  return {
    verdict: {
      sheetFlags, garmentChecks: checks, keptChecks, keptCheckSkipped: kept.length ? null : keptCheckSkipped,
      removedScore: still.length ? 1 : 10,
      keptScore: missing.length ? 1 : (kept.length ? 10 : null),
      finalScore: valid ? 10 : 1, valid, failureReasons,
    },
  };
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

const inlinePartOf = (dataUri) => ({ inline_data: { mime_type: dataUri.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg', data: r2.stripDataUriPrefix(dataUri) } });

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
 * THE GATE (docs/decisions.md 2026-10-10 "avatar sheets are ONE Grok 2 call"): the one sheet judge on the edited sheet plus one
 * garment-gone check per garment taken off and one kept check per garment that stays (evaluateVariantSheet; GARMENT_OFF_SHEET_RULE is
 * also stated to the generator). Until then the gate was the pass-2 style judge shown the base's photoreal pass-1 sheet as Image 2
 * (owner, 2026-10-04); that sheet no longer exists, and a styled base as Image 2 rejected every redress. A missing wardrobe
 * instruction or kept list = NO variant, logged as an error (the page then records the missing sheet).
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
 * (styledAvatarGeneration): the sheet judge's flags, then every per-garment question
 * with its answer. Text and numbers only, never an image.
 */
function gateRecordOf(verdict) {
  return {
    sheetFlags: (verdict?.sheetFlags || []).map(d => ({ type: d.type, word: d.word, cells: d.cells || [] })),
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
    characterName = 'character',
    removedItems = [], usageTracker = null, skipQualityEval = false,
    backendOverride = null, authoredWardrobe = null,
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
      result = await styleTransferGenerate(prompt, baseSheetImageData, backendOverride);
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
        usageTracker, removedGarments: items, keptGarments, keptCheckSkipped,
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
  generateOneCallSheet,
  buildOneCallSheetPrompt,
  headFractionNorm,
  ageProportionsLine,
  SHEET_EMPTY_HANDS_RULE,
  SHEET_NO_LETTERING_RULE,
  TAIL_POSE_RULE,
  phantomTierForAge,
  redressSheetVariant,
  gateRecordOf,
  buildRedressPrompt,
  GARMENT_OFF_SHEET_RULE,
  checkGarmentGone,
  checkKeptGarment,
  evaluateVariantSheet,
  declaredAgeBlock,
  buildGlassesBlock,
  resolveFacePhoto,
  readAvatarHair,
  _internal: { askSheetJudge, inlinePartOf, hairRequest, parseJudgeJson, isEchoedJudgeVerdict, resolveStyleLineForSheet, REAR_TURN_POSE, SHEET_GROUND_RULE, CELL_NAMES_NOT_DRAWN, buildFootwearRule, buildGarmentRule, buildSeasonOutfitBlock, buildUnnamedTrimRule, resolveBodyReference },
};
