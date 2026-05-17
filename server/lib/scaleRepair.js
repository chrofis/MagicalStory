/**
 * Scale-repair pass for "tiny background figure" compositions.
 *
 * Grok consistently fails to render a depth=background character at the
 * intended small scale on a wide / ultra-wide shot — it pulls the figure
 * forward to "make them visible". The eval flags it on every version, but
 * the iterate / inpaint repair paths cannot SHRINK figures (they only fix
 * identity / fix issues at the existing bbox).
 *
 * This module runs UNCONDITIONALLY on any page where the outline metadata
 * declared `depth: background` for one or more characters AND there's at
 * least one non-background character. No eval, no threshold — outline
 * intent is the trigger.
 *
 * Strategy:
 *   1. Page is rendered normally (foreground char with their avatar
 *      reference; under `referenceMode='loose'` the background char is
 *      already correctly NOT given a ref so Grok doesn't anchor them at
 *      avatar-portrait size).
 *   2. The rendered image is passed back to Grok edit with a focused
 *      prompt that says "keep foreground as is, redraw background char as
 *      a tiny distant figure at <position>". The empty-scene plate is
 *      attached as `sceneBackground` for ground anchoring, and the
 *      background character's styled avatar is attached as a reference so
 *      identity survives the shrink.
 *
 * The output replaces the original image as the active version, with a
 * `scale-repair` version tag.
 */

const { log } = require('../utils/logger');

/**
 * Returns true if the scene metadata declares at least one background
 * character AND at least one non-background character — the only
 * composition pattern this pass targets.
 *
 * @param {Object} sceneMetadata - extractSceneMetadata() output
 * @returns {boolean}
 */
function needsScaleRepair(sceneMetadata) {
  const chars = sceneMetadata?.fullData?.characters
    || (Array.isArray(sceneMetadata?.characters) && typeof sceneMetadata.characters[0] === 'object'
        ? sceneMetadata.characters
        : null);
  if (!Array.isArray(chars) || chars.length < 2) return false;
  const bg = chars.filter(c => (c.depth || '').toLowerCase() === 'background');
  const nonBg = chars.filter(c => (c.depth || '').toLowerCase() !== 'background');
  if (bg.length === 0 || nonBg.length === 0) return false;

  // Skip indoor scenes. Rooms have limited depth — there's no "deep
  // background" to push a character into, so the relocate-and-shrink pass
  // either produces a tiny figure crammed against a wall or Grok refuses
  // and keeps the original size. Outline-declared `depth: background`
  // inside an interior typically means "back wall of the room", not
  // "distant in landscape", which works fine at original size.
  // Setting field is a string "indoor"|"outdoor" in unified mode; the
  // legacy trial path wrapped it in { indoorOutdoor }. Handle both.
  const settingRaw = sceneMetadata?.fullData?.setting ?? sceneMetadata?.setting;
  const settingStr = typeof settingRaw === 'string'
    ? settingRaw
    : (settingRaw?.indoorOutdoor || settingRaw?.location || '');
  if (/\bindoor\b/i.test(settingStr)) return false;

  // Don't run when the bg characters are inside a SHARED VESSEL that ties
  // them spatially to the foreground action — boat / cart / wagon / carriage.
  // Page 7 of the Tell story is the canonical bad case: Roger leaps FROM
  // the boat the soldiers are gripping. Shrinking the soldiers shrinks the
  // boat, which widens the leap distance — the opposite of what we want.
  //
  // Only match "inside the / aboard the / in the [vessel]" phrases. Personal
  // mounts ("mounted on a horse", "on horseback") are NOT a shared vessel —
  // they're a single bg figure on their own animal, which is exactly what
  // scale-repair handles best (page 9: Gessler on horse, distant on path).
  const SHARED_VESSEL_RE = /\b(?:inside (?:the|a|its)|aboard (?:the|a)|in (?:the|a) (?:tilting )?(?:boat|raft|ship|vessel|cart|wagon|carriage|coach|sleigh|train|car|carriage|coach))\b/i;
  if (bg.some(c => SHARED_VESSEL_RE.test(c.position || ''))) return false;

  return true;
}

/**
 * Build the prompt for the scale-repair pass. Terse and pointed — the
 * goal is to tell Grok exactly which figure to leave alone and which to
 * shrink-and-replace. Long prose dilutes the signal.
 */
function buildScaleRepairPrompt({ bgChars, fgChars, shot, artStyleDescription }) {
  const lines = [];
  // Grok ALWAYS renders the named characters in the input image — usually
  // too large and too close to the camera. Scale-repair's job is to
  // RELOCATE existing figures, not to add new ones. Phrasing the prompt
  // as "add" caused Grok to leave the original copy in place and paint a
  // second tiny version. Phrase as "move".
  lines.push(`Edit this ${shot || 'wide'} scene by RELOCATING the named characters. Every named character is already drawn somewhere in the input image — do not add new figures. The total figure count must not increase. Each named character must appear EXACTLY ONCE in the output.`);
  lines.push('');
  lines.push('Foreground / midground figures — keep these at their current position and size:');
  for (const c of fgChars) {
    const pos = c.position ? ` — ${c.position}` : '';
    lines.push(`- ${c.name}${pos}`);
  }
  lines.push('');
  lines.push('Background figures — find the existing figure of this character in the input image and MOVE+SHRINK it to the target position below. The relocated figure should be clearly smaller than the foreground figures (roughly one-third their height or less):');
  for (const c of bgChars) {
    // Each bg figure needs three things in one line:
    //   1. a clear name handle for the model,
    //   2. a physical description so Grok knows WHO to draw — name alone
    //      ("Gessler") means nothing to the model,
    //   3. a position phrase telling Grok where in the frame.
    // No fractional sizes ("1/6 of frame height") — Grok ignores them.
    // No "body language only / no facial detail" — that phrasing produced
    // black silhouettes. Just say "tiny in the background".
    const desc = (c.physicalDescription || '').trim();
    const pos = c.position ? ` Target position: ${c.position}.` : '';
    if (desc) {
      lines.push(`- ${c.name} (${desc}): move this character to the deep background.${pos}`);
    } else {
      lines.push(`- ${c.name}: move this character to the deep background.${pos}`);
    }
  }
  lines.push('');
  lines.push('After the move, the background-only zone occupied by the wrongly-sized original (face / torso / clothing) must be repainted with the natural setting (forest / sky / wall / floor) so no trace of the figure remains there.');
  lines.push('');
  // Reference-identifier rule (mirrors the rule we ship in image-generation.txt).
  // scaleRepair builds its own prompt, so the no-name-rendering instruction
  // has to be repeated here.
  lines.push('Character names in this prompt are reference identifiers only — never paint them onto clothing, signs, banners, captions, name tags, or any surface in the scene.');
  lines.push('');
  lines.push('Keep the input image\'s lighting, palette, and overall composition. Do not enlarge the background figures. Do not add other people.');
  if (artStyleDescription) {
    lines.push('');
    lines.push(`ART STYLE: ${artStyleDescription}`);
  }
  return lines.join('\n');
}

/**
 * Run the scale-repair pass on a page that's already been rendered.
 *
 * @param {string} currentImage         - data: URL or base64 of the rendered page image
 * @param {Object} sceneMetadata        - extractSceneMetadata() output for the scene
 * @param {Object} options
 * @param {number} options.pageNumber
 * @param {string|null} options.sceneBackground         - empty-scene plate (data URL); optional
 * @param {Array}  options.backgroundCharacterRefs      - [{ name, photoUrl }] avatar refs for bg chars
 * @param {Array}  options.backgroundCharacterDescriptions - [{ name, description }] physical-trait
 *                                                         descriptions; the model doesn't know
 *                                                         who "Gessler" is — describe him.
 * @param {string|null} options.artStyleDescription     - resolved art-style prose (optional)
 * @param {string|null} options.imageModelOverride      - default 'grok-imagine'
 * @param {string|null} options.aspectRatio
 * @param {Function|null} options.usageTracker
 *
 * @returns {Promise<{imageData: string, modelId: string, usage: object, prompt: string, type: 'scale-repair'} | null>}
 *          null when the scene doesn't need a scale-repair pass.
 */
async function runScaleRepair(currentImage, sceneMetadata, options = {}) {
  if (!currentImage) return null;
  if (!needsScaleRepair(sceneMetadata)) return null;

  const { MODEL_DEFAULTS } = require('../config/models');
  const {
    pageNumber,
    sceneBackground = null,
    backgroundCharacterRefs = [],
    artStyleDescription = null,
    imageModelOverride = 'grok-imagine',
    // No aspect → Grok edit crops the input to square. Always default to the
    // configured page aspect so the result lands on the page at the right shape.
    aspectRatio: aspectRatioIn = null,
    usageTracker = null,
  } = options;
  const aspectRatio = aspectRatioIn || MODEL_DEFAULTS.pageAspect || '3:4';

  const chars = sceneMetadata.fullData?.characters || sceneMetadata.characters;
  const bgChars = chars.filter(c => (c.depth || '').toLowerCase() === 'background');
  const fgChars = chars.filter(c => (c.depth || '').toLowerCase() !== 'background');
  const shot = sceneMetadata.fullData?.shot || sceneMetadata.shot || '';

  // Splice in caller-provided physical descriptions for background characters
  // so Grok knows WHO to draw — the model has no idea who "Gessler" or
  // "Werner" are, only what we describe.
  const descByName = (options.backgroundCharacterDescriptions || [])
    .reduce((m, x) => { if (x?.name && x?.description) m[x.name.toLowerCase()] = x.description; return m; }, {});
  const bgCharsWithDesc = bgChars.map(c => ({
    ...c,
    physicalDescription: descByName[(c.name || '').toLowerCase()] || c.physicalDescription || null,
  }));

  const prompt = buildScaleRepairPrompt({ bgChars: bgCharsWithDesc, fgChars, shot, artStyleDescription });
  log.info(`📐 [SCALE-REPAIR] Page ${pageNumber}: ${fgChars.length} fg / ${bgChars.length} bg | shot=${shot} | bg refs attached: ${backgroundCharacterRefs.length}`);

  // generateImageOnly handles the Grok-edit path when previousImage is set.
  // Loaded lazily because images.js imports storyHelpers which imports back.
  const { generateImageOnly } = require('./images');
  const { IMAGE_MODELS } = require('../config/models');
  const backend = IMAGE_MODELS[imageModelOverride]?.backend || 'grok';

  const result = await generateImageOnly(prompt, backgroundCharacterRefs, {
    pageNumber,
    sceneBackground,
    previousImage: currentImage,
    skipCache: true,
    imageModelOverride,
    imageBackendOverride: backend,
    aspectRatio,
  });

  if (usageTracker && result?.usage) {
    const isGrok = (result.modelId || '').startsWith('grok-imagine');
    usageTracker(isGrok ? 'grok' : 'gemini_image', result.usage, 'scale_repair', result.modelId);
  }

  if (!result?.imageData) {
    log.warn(`⚠️ [SCALE-REPAIR] Page ${pageNumber}: no image returned`);
    return null;
  }

  log.info(`✅ [SCALE-REPAIR] Page ${pageNumber}: completed (model=${result.modelId})`);
  return {
    imageData: result.imageData,
    modelId: result.modelId,
    usage: result.usage,
    prompt,
    type: 'scale-repair',
    grokRefImages: result.grokRefImages || null,
  };
}

module.exports = {
  needsScaleRepair,
  runScaleRepair,
  buildScaleRepairPrompt,
};
