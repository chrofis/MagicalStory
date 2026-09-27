/**
 * charRepairReference.js — the ONE place that decides which reference image a
 * character repair sends, by repair target (owner, 2026-09-27: "Face should get
 * the face ref in big. Body repair should get just the body.").
 *
 *   face repair → the styled sheet's FACE cell for the figure's pose, alone
 *   body repair → the styled sheet's BODY cell for the figure's pose, alone
 *
 * Both are upscaled to REPAIR_REFERENCE_LONG_SIDE and, at send time, padded
 * (never cropped) to the aspect of the image being edited.
 *
 * Why this exists. A face repair used to send the face cell STACKED above the
 * body cell: 256×1024 from a 1024² sheet. Grok edit crops every input to the
 * call's aspect unless it already matches (grok.js editWithGrok, crop is the
 * default), and a face repair runs at 1:1 — so the stack was centre-cropped to
 * 256×256: the chin of the face cell over the head of the tiny body cell,
 * ~14KB next to a ~1.9MB scene (Lab 1561). A body repair's 256×~570 cell was
 * cropped the same way to its cutout aspect. And the admin route and the entity
 * single-page repair sent the RAW 2×4 sheet (cropToFrontColumn only splits a
 * portrait-aspect grid, so a square sheet went through unchanged).
 *
 * Source choice: the styled sheet, not avatar-refs or face thumbnails. The
 * reference must be drawn in the story's art style and costume, and the styled
 * 2×4 sheet for (artStyle, clothing category) is the only image that is; the
 * avatar-refs are photo derivatives sent to the avatar generator. The face cell
 * is sent whole (head and shoulders, as the sheet draws it) rather than cut to
 * the head: hair length is an identity trait and sits below the chin.
 * Known limit: the sheet's face row is drawn hatless, so a face repair's
 * reference carries no headwear — the prompt's clothing text does.
 *
 * Shared by every character-repair caller through faceRepair.repairCharacterFace
 * (automatic char-fix, the manual route, the entity single-page repair, the Test
 * Lab stage): callers hand over the sheet and the pose; the target is decided
 * inside the spine, after the geometry guards have fixed face vs body.
 *
 * The entity identity judge reads the same face cells through
 * buildJudgeReferenceFaces, so the face a repair paints toward and the face a
 * judge compares against are one image.
 */

const sharp = require('sharp');

// Long side of the reference as sent. Grok edits at 1k, so this puts the
// reference at the same working scale as the image it is matched against.
const REPAIR_REFERENCE_LONG_SIDE = 1024;
const REFERENCE_JPEG_QUALITY = 92;
const PAD_BACKGROUND = { r: 255, g: 255, b: 255 };

const SHEET_PHOTO_TYPE = /^(styled|costumed|clothing)-/;

/** Is this reference a styled 2×4 sheet (as opposed to a single photo)? */
function isSheetPhotoType(photoType) {
  return SHEET_PHOTO_TYPE.test(String(photoType || ''));
}

async function upscaleToLongSide(buf, longSide) {
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) throw new Error('repair reference: unreadable image');
  const scale = longSide / Math.max(meta.width, meta.height);
  const pipeline = scale > 1
    ? sharp(buf).resize(Math.round(meta.width * scale), Math.round(meta.height * scale), { kernel: 'lanczos3' })
    : sharp(buf);
  return pipeline.flatten({ background: PAD_BACKGROUND }).jpeg({ quality: REFERENCE_JPEG_QUALITY }).toBuffer();
}

/**
 * Build the reference a repair sends.
 *
 * @param {Buffer} buf - the reference bytes (a styled 2×4 sheet, or a single photo)
 * @param {Object} o
 * @param {'face'|'body'} o.target - what the repair repaints
 * @param {boolean} o.isSheet - buf is a 2×4 sheet (isSheetPhotoType)
 * @param {string} [o.pose] - resolveCellPose(...).pose; REQUIRED for a sheet
 * @returns {Promise<{ buf: Buffer, kind: string, width: number, height: number }>}
 */
async function buildRepairReference(buf, { target, isSheet, pose } = {}) {
  if (target !== 'face' && target !== 'body') throw new Error(`repair reference: target must be 'face' or 'body' (got ${target})`);
  let src = buf;
  let kind = 'photo';
  if (isSheet) {
    if (!pose) throw new Error('repair reference: a sheet reference needs the figure\'s pose (resolveCellPose) to pick its cell');
    const { cropAvatarCell } = require('./sceneComposite');
    const cells = await cropAvatarCell(buf, { pose, includeFace: target === 'face' });
    src = target === 'face' ? cells.face : cells.body;
    if (!src) throw new Error(`repair reference: sheet has no ${target} cell for pose ${pose}`);
    kind = `${target}-cell-${pose}`;
  }
  const out = await upscaleToLongSide(src, REPAIR_REFERENCE_LONG_SIDE);
  const meta = await sharp(out).metadata();
  return { buf: out, kind, width: meta.width, height: meta.height };
}

const JUDGE_POSE_ORDER = ['front', 'threeQuarter', 'profile', 'back'];

/**
 * The reference faces the entity identity judge reads, built by the same
 * builder a face repair sends (owner, 2026-09-27: the judge gets the reference
 * face large and legible). Each face is its OWN image: gemini-2.5-flash bills
 * and sees every image as one fixed 258-token tile whatever its pixel size
 * (countTokens, 2026-09-27: 256² … 3000×1000 all 258), so a face inside the
 * head grid is shrunk with the grid, while a separate image gets the whole
 * tile. The front face always; then the face of each other pose the grid's
 * cells were rendered from (the cell a page's generator was given).
 *
 * A non-sheet reference (a Visual Bible secondary's image) is sent whole, once.
 *
 * @param {Buffer} buf - the reference bytes (styled 2×4 sheet or single image)
 * @param {Object} o
 * @param {boolean} o.isSheet
 * @param {string[]} [o.poses] - resolveCellPose poses of the grid's cells
 * @returns {Promise<Array<{ pose: string|null, buf: Buffer }>>}
 */
async function buildJudgeReferenceFaces(buf, { isSheet, poses = [] } = {}) {
  if (!isSheet) {
    const out = await upscaleToLongSide(buf, REPAIR_REFERENCE_LONG_SIDE);
    return [{ pose: null, buf: out }];
  }
  const wanted = new Set(['front', ...poses.filter(p => JUDGE_POSE_ORDER.includes(p))]);
  const faces = [];
  for (const pose of JUDGE_POSE_ORDER.filter(p => wanted.has(p))) {
    const r = await buildRepairReference(buf, { target: 'face', isSheet: true, pose });
    faces.push({ pose, buf: r.buf });
  }
  return faces;
}

/**
 * Pad (never crop) a reference to a Grok aspect preset string ('1:1', '3:4', …),
 * so editWithGrok's own aspect normalisation finds it already matching and
 * leaves it alone. Cropping is what reduced the stacked reference to its middle.
 */
async function fitReferenceToAspect(buf, aspectStr) {
  const [aw, ah] = String(aspectStr).split(':').map(Number);
  if (!(aw > 0 && ah > 0)) throw new Error(`repair reference: bad aspect "${aspectStr}"`);
  const meta = await sharp(buf).metadata();
  const target = aw / ah;
  const current = meta.width / meta.height;
  let w = meta.width, h = meta.height;
  if (current > target) h = Math.round(meta.width / target);
  else w = Math.round(meta.height * target);
  const left = Math.floor((w - meta.width) / 2), top = Math.floor((h - meta.height) / 2);
  return sharp(buf)
    .extend({ left, right: w - meta.width - left, top, bottom: h - meta.height - top, background: PAD_BACKGROUND })
    .jpeg({ quality: REFERENCE_JPEG_QUALITY })
    .toBuffer();
}

/**
 * The figure's cell pose on a page, from its scene-metadata character entry
 * (fullData.characters, else characters, else sceneCharacters) through the one
 * resolver, storyAvatars.resolveCellPose.
 */
function referencePoseFor(scene, charName) {
  const { resolveCellPose } = require('./storyAvatars');
  const metaChars = scene?.sceneMetadata?.fullData?.characters
    || scene?.sceneMetadata?.characters || scene?.sceneCharacters || [];
  const want = String(charName || '').toLowerCase();
  const sc = (Array.isArray(metaChars) ? metaChars : []).find(c =>
    ((typeof c === 'string' ? c : c?.name) || '').toLowerCase() === want);
  return resolveCellPose(typeof sc === 'object' && sc ? sc : {}).pose;
}

module.exports = {
  REPAIR_REFERENCE_LONG_SIDE,
  referencePoseFor,
  isSheetPhotoType,
  buildRepairReference,
  buildJudgeReferenceFaces,
  fitReferenceToAspect,
};
