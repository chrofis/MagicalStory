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

// rgbToHue copied from sceneComposite (not exported there). Kept inline so this
// module stays self-contained.
function _rgbToHue(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

/**
 * Crop the phantom silhouette region from the blocking image with padding so
 * the model sees the shape edge-to-edge plus a small margin of context.
 *
 * When `cleanBgBuf` + `otherColors` are provided, any pixels in the cropped
 * region that match one of the OTHER cast members' silhouette hues are
 * repainted with the corresponding pixels from the clean background — so the
 * model sees ONLY the target character's silhouette plus the surrounding
 * scene context, never another character's coloured blob.
 *
 * @param {Buffer} blockingBuf
 * @param {{x:number,y:number,width:number,height:number}} bbox
 * @param {number} paddingRatio - extra fraction of bbox dimensions to include around it
 * @param {object} opts
 * @param {Buffer} [opts.cleanBgBuf] - the pre-silhouette background (same dimensions as blockingBuf)
 * @param {string[]} [opts.otherColors] - hex colour strings (#RRGGBB) of OTHER silhouettes to mask out
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

  // Fast path: no other-colour masking requested.
  if (!opts.cleanBgBuf || !Array.isArray(opts.otherColors) || opts.otherColors.length === 0) {
    return sharp(blockingBuf)
      .extract({ left, top, width, height })
      .jpeg({ quality: 92 })
      .toBuffer();
  }

  // Repaint path: extract the same region from both images as raw RGBA,
  // then walk pixels — when the blocking pixel matches one of the other-
  // character hues, replace it with the corresponding clean-bg pixel.
  const blockingCrop = await sharp(blockingBuf)
    .extract({ left, top, width, height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cleanCrop = await sharp(opts.cleanBgBuf)
    .extract({ left, top, width, height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (blockingCrop.info.width !== cleanCrop.info.width
      || blockingCrop.info.height !== cleanCrop.info.height) {
    log.warn('[PHANTOM-POSE] cropPhantom: blocking and clean-bg dimensions differ — skipping mask repaint');
    return sharp(blockingBuf)
      .extract({ left, top, width, height })
      .jpeg({ quality: 92 })
      .toBuffer();
  }

  // Pre-compute target hues for fast pixel-loop comparison.
  const otherHues = opts.otherColors.map((hex) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return _rgbToHue(r, g, b);
  });

  const out = Buffer.from(blockingCrop.data); // copy so we can mutate
  const clean = cleanCrop.data;
  let repainted = 0;
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i], g = out[i + 1], b = out[i + 2];
    const maxCh = Math.max(r, g, b);
    const minCh = Math.min(r, g, b);
    const sat = (maxCh - minCh) / (maxCh || 1);
    if (sat < 0.55 || maxCh < 80) continue; // not a saturated silhouette pixel
    const hue = _rgbToHue(r, g, b);
    for (const oh of otherHues) {
      let dh = Math.abs(hue - oh);
      if (dh > 180) dh = 360 - dh;
      if (dh <= 35) {
        out[i]     = clean[i];
        out[i + 1] = clean[i + 1];
        out[i + 2] = clean[i + 2];
        out[i + 3] = clean[i + 3];
        repainted++;
        break;
      }
    }
  }
  log.debug(`[PHANTOM-POSE] cropPhantom: repainted ${repainted} other-silhouette pixels with clean BG`);
  return sharp(out, { raw: { width: blockingCrop.info.width, height: blockingCrop.info.height, channels: 4 } })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * Build the Grok-edit prompt that fuses identity (image 1) with pose (image 2).
 */
function buildPhantomPosePrompt({ charName, colorName, action }) {
  const actionClause = action
    ? `The character is ${action}.`
    : 'The character is in the exact posture, body position, limb arrangement, and gaze direction shown by the silhouette.';

  return `You are given two reference images:

Image 1 — a 2×4 character grid showing ${charName || 'the same character'} from multiple angles. This image is the IDENTITY reference: face, hair (colour, length, style), skin tone, body proportions, clothing pattern and colours.

Image 2 — a single ${colorName ? colorName + ' ' : ''}silhouette of the same character in the pose we want to render. The silhouette's outline tells you the POSE: which way the body faces, which limbs are bent, whether the figure is standing / sitting / kneeling / reaching / climbing / jumping, etc.

Task: render ${charName || 'the character'} from Image 1 in the EXACT pose, body angle, limb positions, and gaze direction shown by Image 2's silhouette. ${actionClause}

CRITICAL identity rules — every detail comes from Image 1:
- Face, eyes, hair colour, hair length, hair style: identical to Image 1.
- Skin tone, body build, age: identical to Image 1.
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
  aspectRatio = '9:16',
  model = GROK_MODELS.STANDARD,
  usageTracker,
  // When provided, cropPhantom will mask out OTHER-colour silhouettes that
  // happen to fall within the cropped region — repaints them with pixels
  // from the clean background so Grok sees only the target character.
  cleanBgBuf = null,
  otherColors = null,
}) {
  if (!charSheet2x4) throw new Error('renderCharacterInPhantomPose: missing charSheet2x4');
  if (!blockingImageBuf) throw new Error('renderCharacterInPhantomPose: missing blockingImageBuf');
  if (!bbox) throw new Error('renderCharacterInPhantomPose: missing bbox');

  // Normalise the sheet to a data URL string for editWithGrok.
  const sheetDataUrl = typeof charSheet2x4 === 'string'
    ? (charSheet2x4.startsWith('data:') ? charSheet2x4 : `data:image/png;base64,${charSheet2x4}`)
    : `data:image/png;base64,${charSheet2x4.toString('base64')}`;

  const phantomCropBuf = await cropPhantom(blockingImageBuf, bbox, 0.15, { cleanBgBuf, otherColors });
  const phantomDataUrl = `data:image/jpeg;base64,${phantomCropBuf.toString('base64')}`;

  const prompt = buildPhantomPosePrompt({ charName, colorName, action });

  log.info(`[PHANTOM-POSE] rendering ${charName || 'character'} in phantom pose (${colorName || '?'} silhouette ${bbox.width}×${bbox.height})`);

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
    },
  };
}

module.exports = {
  renderCharacterInPhantomPose,
  cropPhantom,        // exported for tests / debug
  buildPhantomPosePrompt,
};
