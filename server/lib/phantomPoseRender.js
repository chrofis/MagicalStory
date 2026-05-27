/**
 * Phantom-pose render.
 *
 * Given (a) a character's 2×4 reference sheet (identity: face/hair/clothing,
 * 8 standing views) and (b) a phantom silhouette crop from the blocking pass
 * (pose: solid-colour blob that already matches the desired body posture —
 * sitting on a bench, climbing a tree, jumping, reaching, etc.), produce a
 * single image of THAT character in THE silhouette's pose, on a plain white
 * background.
 *
 * Why this exists: the scene-composite pipeline previously cut a STANDING
 * cell from the 2×4 sheet (front / threeQuarter / profile / back) and pasted
 * it at the silhouette bbox. The blend pass then had to re-pose the standing
 * character to sit / climb / jump in addition to harmonising lighting. Result:
 * Frankenstein-ed poses, broken anatomy. This module decouples pose from
 * blend — one extra Grok edit call per character per page that yields a
 * correctly-posed cutout-ready character.
 *
 * Cost: +N×$0.02 per page where N = cast size. Typical scene 2–3 chars →
 * +$0.04–$0.06 per page. Gated by MODEL_DEFAULTS.phantomPoseRender (default
 * false until validated).
 *
 * Returns the rendered character image as a base64 data URL. The caller is
 * responsible for background-removing, trimming, scaling, and compositing
 * onto the scene background — same downstream as the static-cell path.
 */

'use strict';

const sharp = require('sharp');
const { log } = require('../utils/logger');
const { editWithGrok, GROK_MODELS } = require('./grok');

/**
 * Crop the phantom silhouette region from the blocking image with padding so
 * the model sees the shape edge-to-edge plus a small margin of context.
 *
 * When a `silhouetteMask` + `cleanBgBuf` are provided, every pixel in the
 * cropped region that is NOT a target silhouette pixel gets repainted with
 * the corresponding pixel from the derived clean BG. The result is: the
 * target character's coloured silhouette on top of the original scene
 * context with all other silhouettes (and any palette-colliding background)
 * cleanly erased.
 *
 * @param {Buffer} blockingBuf
 * @param {{x:number,y:number,width:number,height:number}} bbox
 * @param {number} paddingRatio - extra fraction of bbox dimensions to include around it
 * @param {object} opts
 * @param {Buffer} [opts.cleanBgBuf] - the derived clean BG (same canvas as blockingBuf)
 * @param {Uint8Array} [opts.silhouetteMask] - full-canvas mask (W*H bytes); 1 = target pixel
 * @param {number} [opts.canvasWidth] - silhouetteMask stride / canvas width
 * @param {number} [opts.canvasHeight] - silhouetteMask height
 * @returns {Promise<Buffer>}
 */
async function cropPhantom(blockingBuf, bbox, paddingRatio = 0.15, opts = {}) {
  const meta = await sharp(blockingBuf).metadata();
  const padX = Math.round(bbox.width * paddingRatio);
  const padY = Math.round(bbox.height * paddingRatio);
  const left = Math.max(0, bbox.x - padX);
  const top = Math.max(0, bbox.y - padY);
  const right = Math.min(meta.width, bbox.x + bbox.width + padX);
  const bottom = Math.min(meta.height, bbox.y + bbox.height + padY);
  const width = right - left;
  const height = bottom - top;

  // Plain extract when no mask + clean BG to repaint with.
  if (!opts.silhouetteMask || !opts.cleanBgBuf) {
    return sharp(blockingBuf)
      .extract({ left, top, width, height })
      .jpeg({ quality: 92 })
      .toBuffer();
  }

  const W = opts.canvasWidth || meta.width;
  const H = opts.canvasHeight || meta.height;
  const mask = opts.silhouetteMask;
  if (mask.length !== W * H) {
    log.warn(`[PHANTOM-POSE] cropPhantom: mask length ${mask.length} ≠ W*H ${W*H} — falling back to plain extract`);
    return sharp(blockingBuf)
      .extract({ left, top, width, height })
      .jpeg({ quality: 92 })
      .toBuffer();
  }

  const blockingCrop = await sharp(blockingBuf)
    .extract({ left, top, width, height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cleanCrop = await sharp(opts.cleanBgBuf)
    .resize(W, H, { fit: 'fill' })
    .extract({ left, top, width, height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const out = Buffer.from(blockingCrop.data);
  const clean = cleanCrop.data;
  let repainted = 0;
  for (let ly = 0; ly < height; ly++) {
    for (let lx = 0; lx < width; lx++) {
      const px = left + lx;
      const py = top + ly;
      if (mask[py * W + px]) continue; // target silhouette pixel — keep as-is
      const o = (ly * width + lx) * 4;
      out[o]     = clean[o];
      out[o + 1] = clean[o + 1];
      out[o + 2] = clean[o + 2];
      out[o + 3] = clean[o + 3];
      repainted++;
    }
  }
  log.debug(`[PHANTOM-POSE] cropPhantom: repainted ${repainted}/${width*height} non-target pixels with clean BG`);
  return sharp(out, { raw: { width, height, channels: 4 } })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * Age-appropriate head-to-body ratio, expressed in head-heights (the body is
 * ~N heads tall, so the head is ~1/N of the full standing height). Mirrors the
 * mapping already used for avatars in prompts/avatar-ace-prompt.txt
 * (Infant=4, Child=6, Teen=7, Adult=8). Returns null for an unknown or
 * unparseable age so the caller defers to the 2×4 sheet's own proportions.
 *
 * @param {string|number} age
 * @returns {number|null}
 */
function headToBodyRatioForAge(age) {
  const n = parseInt(age, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n <= 2) return 4;    // infant / toddler
  if (n <= 12) return 6;   // child
  if (n <= 17) return 7;   // teen
  return 8;                // adult
}

/**
 * Build the Grok-edit prompt that fuses identity (image 1) with pose (image 2).
 */
function buildPhantomPosePrompt({ charName, colorName, action, headToBodyRatio = null, ageLabel = null }) {
  const actionClause = action
    ? `The character is ${action}.`
    : 'The character is in the exact posture, body position, limb arrangement, and gaze direction shown by the silhouette.';

  // Age-appropriate head size. The blocking silhouette (Image 2) tends to carry
  // a roughly adult head, so a young child posed into it comes out with too
  // small a head. Pin the head size to the age-derived ratio and let the
  // silhouette govern only orientation, posture, and limb arrangement.
  const proportionClause = headToBodyRatio
    ? `\n- Head-to-body proportion: ${ageLabel ? `the character is ${ageLabel}, so ` : ''}render the head at roughly 1/${headToBodyRatio} of the full standing height (about ${headToBodyRatio} head-heights tall). Keep this head size even if Image 2's silhouette head looks smaller — the silhouette sets only orientation, posture, and limb arrangement, not head size.`
    : '';

  return `You are given two reference images:

Image 1 — a 2×4 character grid showing ${charName || 'the same character'} from multiple angles. This image is the IDENTITY reference: face, hair (colour, length, style), skin tone, body proportions, clothing pattern and colours.

Image 2 — a single ${colorName ? colorName + ' ' : ''}silhouette of the same character in the pose we want to render. The silhouette's outline tells you the POSE: which way the body faces, which limbs are bent, whether the figure is standing / sitting / kneeling / reaching / climbing / jumping, etc.

Task: render ${charName || 'the character'} from Image 1 in the EXACT pose, body angle, limb positions, and gaze direction shown by Image 2's silhouette. ${actionClause}

CRITICAL identity rules — every detail comes from Image 1:
- Face, eyes, hair colour, hair length, hair style: identical to Image 1.
- Skin tone, body build, age: identical to Image 1.${proportionClause}
- Clothing pattern and colours: identical to Image 1. If the silhouette covers part of the clothing, infer the unseen part from Image 1's reference angles.

CRITICAL pose rules — every detail comes from Image 2:
- Body orientation (front / three-quarter / profile / back) follows the silhouette.
- Posture (standing / sitting / kneeling / etc.) follows the silhouette.
- Limb positions and gaze direction follow the silhouette.

Output: ONE figure of the character only, on a plain pure-white background (#FFFFFF). NO environment, NO furniture, NO props from the original scene, NO shadow on the ground. The character fills most of the frame, centred. Photorealistic / illustration style consistent with Image 1.`;
}

/**
 * Render one character in the pose shown by their phantom silhouette.
 *
 * @param {object} args
 * @param {string|Buffer} args.charSheet2x4 - the 2×4 character sheet (data-URI string or Buffer)
 * @param {Buffer} args.blockingImageBuf - the full blocking image buffer
 * @param {{x:number,y:number,width:number,height:number}} args.bbox - phantom bbox in blocking
 * @param {string} [args.charName] - for the prompt
 * @param {string} [args.colorName] - silhouette colour word (e.g. "green") for the prompt
 * @param {string} [args.action] - scene-described action ("sitting on a bench")
 * @param {string} [args.aspectRatio] - target output aspect; defaults to 9:16 (portrait, single figure)
 * @param {string} [args.model] - Grok model id
 * @param {Function} [args.usageTracker] - optional (provider, usage, label, modelId) => void
 * @returns {Promise<{imageData: string, usage: object, debug: object}>}
 */
async function renderCharacterInPhantomPose({
  charSheet2x4,
  blockingImageBuf,
  bbox,
  charName,
  colorName,
  action,
  age = null,
  aspectRatio = '9:16',
  model = GROK_MODELS.STANDARD,
  usageTracker,
  // When provided, cropPhantom uses the silhouette mask to repaint every
  // non-target pixel in the cropped region with derived clean-BG pixels —
  // so Grok sees only the target character's silhouette + scene context.
  cleanBgBuf = null,
  silhouetteMask = null,
  canvasWidth = null,
  canvasHeight = null,
}) {
  if (!charSheet2x4) throw new Error('renderCharacterInPhantomPose: missing charSheet2x4');
  if (!blockingImageBuf) throw new Error('renderCharacterInPhantomPose: missing blockingImageBuf');
  if (!bbox) throw new Error('renderCharacterInPhantomPose: missing bbox');

  // Normalise the sheet to a data URL string for editWithGrok.
  const sheetDataUrl = typeof charSheet2x4 === 'string'
    ? (charSheet2x4.startsWith('data:') ? charSheet2x4 : `data:image/png;base64,${charSheet2x4}`)
    : `data:image/png;base64,${charSheet2x4.toString('base64')}`;

  const phantomCropBuf = await cropPhantom(blockingImageBuf, bbox, 0.15, {
    cleanBgBuf, silhouetteMask, canvasWidth, canvasHeight,
  });
  const phantomDataUrl = `data:image/jpeg;base64,${phantomCropBuf.toString('base64')}`;

  const headToBodyRatio = headToBodyRatioForAge(age);
  const parsedAge = parseInt(age, 10);
  const ageLabel = headToBodyRatio && Number.isFinite(parsedAge) ? `${parsedAge} years old` : null;
  const prompt = buildPhantomPosePrompt({ charName, colorName, action, headToBodyRatio, ageLabel });

  log.info(`[PHANTOM-POSE] rendering ${charName || 'character'} in phantom pose (${colorName || '?'} silhouette ${bbox.width}×${bbox.height}${headToBodyRatio ? `, age ${parsedAge}→${headToBodyRatio} head-heights` : ''})`);

  const result = await editWithGrok(prompt, [sheetDataUrl, phantomDataUrl], {
    aspectRatio,
    model,
    // Sheet and phantom are both already on near-white backgrounds, so pad
    // instead of crop when coercing to target aspect — preserves the full
    // figure / full silhouette outline.
    padInput: true,
  });

  if (usageTracker) usageTracker('grok', result.usage, 'phantom_pose_render', result.modelId);

  return {
    imageData: result.imageData,
    usage: result.usage,
    debug: {
      prompt,
      phantomCrop: phantomDataUrl,
      bbox,
      charName,
      colorName,
      action: action || null,
      headToBodyRatio: headToBodyRatio || null,
    },
  };
}

module.exports = {
  renderCharacterInPhantomPose,
  cropPhantom,        // exported for tests / debug
  buildPhantomPosePrompt,
  headToBodyRatioForAge,
};
