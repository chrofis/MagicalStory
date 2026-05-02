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
  return bg.length > 0 && nonBg.length > 0;
}

/**
 * Build the prompt for the scale-repair pass. Terse and pointed — the
 * goal is to tell Grok exactly which figure to leave alone and which to
 * shrink-and-replace. Long prose dilutes the signal.
 */
function buildScaleRepairPrompt({ bgChars, fgChars, shot, artStyleDescription }) {
  const lines = [];
  lines.push(`Edit this image to fix character placement and scale. The composition is a ${shot || 'wide'} shot — the vast distance between foreground and background figures must be visually obvious.`);
  lines.push('');
  lines.push('KEEP AS RENDERED (do not change pose, size, face, clothing, or position):');
  for (const c of fgChars) {
    const pos = c.position ? ` (${c.position})` : '';
    lines.push(`- ${c.name}${pos}`);
  }
  lines.push('');
  lines.push('SHRINK AND REPLACE — these characters MUST appear as TINY DISTANT FIGURES, much smaller than the foreground:');
  for (const c of bgChars) {
    const pos = c.position ? ` Place at: ${c.position}.` : '';
    lines.push(`- ${c.name}: redraw as a tiny silhouette occupying roughly 1/6 to 1/8 of frame height. Body language only — no facial detail.${pos}`);
  }
  lines.push('');
  lines.push('Do not add new characters. Do not enlarge any background figure. Do not move the foreground figures. Maintain the existing lighting, palette, and composition.');
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

  const {
    pageNumber,
    sceneBackground = null,
    backgroundCharacterRefs = [],
    artStyleDescription = null,
    imageModelOverride = 'grok-imagine',
    aspectRatio = null,
    usageTracker = null,
  } = options;

  const chars = sceneMetadata.fullData?.characters || sceneMetadata.characters;
  const bgChars = chars.filter(c => (c.depth || '').toLowerCase() === 'background');
  const fgChars = chars.filter(c => (c.depth || '').toLowerCase() !== 'background');
  const shot = sceneMetadata.fullData?.shot || sceneMetadata.shot || '';

  const prompt = buildScaleRepairPrompt({ bgChars, fgChars, shot, artStyleDescription });
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
