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
 * character AND at least one FOREGROUND character — the only
 * composition pattern this pass targets.
 *
 * Trigger rule history:
 *   - Was: any background + any non-background (foreground OR midground).
 *     But midground + background scenes don't need scale-repair —
 *     everyone is roughly the same depth band; Grok renders them at
 *     comparable sizes by default. Running the pass on those scenes
 *     either uselessly shrinks midground figures further or fails the
 *     edit and burns Grok credits. Real-world miss: smoke #4 page 4 had
 *     Emma/Noah/Hans/Sarah all midground at a garden table and Daniel
 *     "background" at the fence behind — outline labelled him background
 *     but he's only a few metres back, well within mid-distance. Scale-
 *     repair ran, tried to shrink Daniel further than he should be,
 *     produced a worse result.
 *   - Now: requires actual foreground + background. If the scene has
 *     only midground + background (no foreground), skip.
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
  const depthOf = (c) => (c.depth || '').toLowerCase();
  const bg = chars.filter(c => depthOf(c) === 'background');
  const fg = chars.filter(c => depthOf(c) === 'foreground');
  if (bg.length === 0 || fg.length === 0) return false;

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
function buildScaleRepairPrompt({ bgChars, fgChars, shot, artStyleDescription, interactions = [] }) {
  const lines = [];
  // Grok ALWAYS renders the named characters in the input image — usually
  // too large and too close to the camera. Scale-repair's job is to
  // RELOCATE existing figures, not to add new ones. Phrasing the prompt
  // as "add" caused Grok to leave the original copy in place and paint a
  // second tiny version. Phrase as "move".
  lines.push(`Edit this ${shot || 'wide'} scene by RELOCATING the named characters. Every named character is already drawn somewhere in the input image — do not add new figures. The total figure count must not increase. Each named character must appear EXACTLY ONCE in the output.`);
  lines.push('');

  // Action lookup: per-character interactions from the scene metadata.
  // Without these the prompt only described WHERE each character is, never
  // WHAT they're doing — Grok lost gestures (Emma reaching into the chest,
  // Hans holding the glass) during the relocation. Re-asserting the action
  // tells the model "keep this gesture intact" alongside "keep this
  // position".
  const actionFor = (name) => {
    if (!Array.isArray(interactions)) return '';
    const list = interactions.filter(i => i?.character === name && i?.where);
    if (list.length === 0) return '';
    // 1-2 sentences max. Comma-joined where-clauses; if more than 2, keep first 2.
    return list.slice(0, 2).map(i => i.where).join('; ');
  };

  lines.push('Foreground / midground figures — keep these at their current position, size, AND action. The position phrase says where in the frame they sit; the action phrase says what they are physically doing — preserve both exactly from the input image.');
  for (const c of fgChars) {
    const pos = c.position ? ` — ${c.position}` : '';
    const action = actionFor(c.name);
    const actionLine = action ? ` Action: ${action}.` : '';
    lines.push(`- ${c.name}${pos}.${actionLine}`);
  }
  lines.push('');
  lines.push('Background figures — find the existing figure of this character in the input image and MOVE+SHRINK it to the target position below. The relocated figure should be clearly smaller than the foreground figures (roughly one-third their height or less). Preserve the action the figure is performing even at the smaller size — if they were facing the camera, keep them facing the camera; if they were watching the foreground action, keep them watching it:');
  for (const c of bgChars) {
    // Each bg figure needs three things in one line:
    //   1. a clear name handle for the model,
    //   2. a physical description so Grok knows WHO to draw — name alone
    //      ("Gessler") means nothing to the model,
    //   3. a position phrase telling Grok where in the frame,
    //   4. an action phrase so the shrunken figure keeps its gesture
    //      (facing the table, looking at the path, etc.).
    // No fractional sizes ("1/6 of frame height") — Grok ignores them.
    // No "body language only / no facial detail" — that phrasing produced
    // black silhouettes. Just say "tiny in the background".
    const desc = (c.physicalDescription || '').trim();
    const pos = c.position ? ` Target position: ${c.position}.` : '';
    const action = actionFor(c.name);
    const actionLine = action ? ` Action: ${action}.` : '';
    if (desc) {
      lines.push(`- ${c.name} (${desc}): move this character to the deep background.${pos}${actionLine}`);
    } else {
      lines.push(`- ${c.name}: move this character to the deep background.${pos}${actionLine}`);
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
 * Verify a scale-repair edit did not delete the figures it was asked to
 * relocate. Grok's relocate-edit sometimes erases the background figure
 * instead of shrinking it (job_1781289599516 p9: Gessler removed, only the
 * anonymous background silhouettes left — the damaged image then shipped).
 *
 * One Gemini-flash call on the EDITED image. Each background character is
 * checked by their visual signature (clothing, colours, mount), never by
 * name — a generic silhouette can pass for a name, not for "crimson
 * fur-trimmed cloak with a white-feathered hat".
 *
 * Fails OPEN: an API/parsing hiccup accepts the repair (current behaviour);
 * only a confident "not present" discards it.
 *
 * @param {string} imageData - edited image (data URL or raw base64)
 * @param {Array}  bgChars   - background characters with .physicalDescription
 * @returns {Promise<{allPresent: boolean, missing: string[]}>}
 */
async function verifyScaleRepair(imageData, bgChars, { pageNumber = null, usageTracker = null } = {}) {
  const toCheck = (bgChars || []).filter(c => (c.physicalDescription || '').trim());
  if (toCheck.length === 0) return { allPresent: true, missing: [], skipped: true };
  const pageLabel = pageNumber != null ? `Page ${pageNumber}: ` : '';
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const mimeType = String(imageData).match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    const base64 = String(imageData).replace(/^data:image\/\w+;base64,/, '');
    const lines = toCheck.map((c, i) => `${i + 1}. ${c.physicalDescription.trim()}`);
    const prompt = [
      'This illustration was just edited to relocate some figures. Verify the edit did not delete anyone.',
      'For each numbered description below, answer whether a figure matching it is visible ANYWHERE in the image, at ANY size — including tiny distant figures and partial views.',
      'Judge ONLY by the visual signature (clothing, colours, mount, accessories).',
      '',
      ...lines,
      '',
      'Return JSON only: {"checks":[{"index":1,"present":true,"confidence":0.9}]}',
    ].join('\n');
    const result = await model.generateContent([
      { inlineData: { mimeType, data: base64 } },
      { text: prompt },
    ]);
    const text = result.response.text();
    if (usageTracker && result.response.usageMetadata) {
      usageTracker('gemini_quality', {
        input_tokens: result.response.usageMetadata.promptTokenCount || 0,
        output_tokens: result.response.usageMetadata.candidatesTokenCount || 0,
      }, 'scale_repair_verify', 'gemini-2.5-flash');
    }
    const parsed = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    if (!Array.isArray(parsed.checks)) throw new Error('unparseable verification response');
    const missing = [];
    for (let i = 0; i < toCheck.length; i++) {
      const check = parsed.checks.find(x => Number(x.index) === i + 1);
      if (check && check.present === false) missing.push(toCheck[i].name || `figure ${i + 1}`);
    }
    return { allPresent: missing.length === 0, missing };
  } catch (err) {
    log.warn(`⚠️ [SCALE-REPAIR] ${pageLabel}verification failed (${err.message}) — accepting repair unverified`);
    return { allPresent: true, missing: [], error: err.message };
  }
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
    foregroundCharacterRefs = [],
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

  // Pull declared interactions so the prompt re-asserts each character's
  // action alongside their position. Without this the relocation lost
  // gestures (Emma reaching into the chest, Hans holding the glass).
  const interactions = sceneMetadata?.fullData?.interactions || sceneMetadata?.interactions || [];
  const prompt = buildScaleRepairPrompt({ bgChars: bgCharsWithDesc, fgChars, shot, artStyleDescription, interactions });
  // Combine refs: foreground avatars (identity anchors for the kept figures)
  // first, then any explicit background refs (usually empty — see callsite
  // comment in server.js). Foreground avatars stop Grok from drifting the
  // identity of kept figures while it relocates the bg figure.
  const characterRefs = [...foregroundCharacterRefs, ...backgroundCharacterRefs];
  log.info(`📐 [SCALE-REPAIR] Page ${pageNumber}: ${fgChars.length} fg / ${bgChars.length} bg | shot=${shot} | refs attached: ${characterRefs.length} (${foregroundCharacterRefs.length} fg + ${backgroundCharacterRefs.length} bg)`);

  // generateImageOnly handles the Grok-edit path when previousImage is set.
  // Loaded lazily because images.js imports storyHelpers which imports back.
  const { generateImageOnly } = require('./images');
  const { IMAGE_MODELS } = require('../config/models');
  const backend = IMAGE_MODELS[imageModelOverride]?.backend || 'grok';

  const result = await generateImageOnly(prompt, characterRefs, {
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

  // Gate: every described background character must still be visible in the
  // edited image. A relocate-edit that deleted a figure returns null so the
  // caller keeps the pre-repair image as the active version.
  const verification = await verifyScaleRepair(result.imageData, bgCharsWithDesc, { pageNumber, usageTracker });
  if (!verification.allPresent) {
    log.warn(`⚠️ [SCALE-REPAIR] Page ${pageNumber}: edit removed ${verification.missing.join(', ')} — discarding repair, keeping original image`);
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
  verifyScaleRepair,
};
