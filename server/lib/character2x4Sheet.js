/**
 * Character 2×4 reference sheet generator (variant A).
 *
 * Generates one 8-cell sheet per character per costume:
 *   - Top row (cells 1–4): face front / 45° / profile / back-of-head
 *   - Bottom row (cells 5–8): full body at the same four angles, costumed
 *
 * Inputs:
 *   - phantom (the pose template — bundled at server/assets/phantom-watercolor.png)
 *   - styled 2×2 avatar (existing production output from generateStyledCostumedAvatar)
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
const { log } = require('../utils/logger');
const { editWithGrok, GROK_MODELS } = require('./grok');

const PHANTOM_PATH = path.resolve(__dirname, '..', 'assets', 'phantom-watercolor.png');
let phantomCache = null;

function loadPhantom() {
  if (phantomCache) return phantomCache;
  if (!fs.existsSync(PHANTOM_PATH)) {
    throw new Error(`Phantom asset missing at ${PHANTOM_PATH}. Run scripts/test-phantom-generate.js and copy the output here.`);
  }
  const buf = fs.readFileSync(PHANTOM_PATH);
  phantomCache = `data:image/png;base64,${buf.toString('base64')}`;
  return phantomCache;
}

// Art-style descriptors — keep aligned with ART_STYLE_PROMPTS in
// server/lib/styledAvatars.js. Only the strings we actually use here.
const ART_STYLE_LINES = {
  watercolor:   "soft watercolor children's storybook illustration style — gentle washes, simple outlines",
  pixar:        "Pixar 3D illustration style — smooth shading, clean rim light",
  anime:        "anime line-art style — clean lines, flat shading",
  cartoon:      "modern flat cartoon, bold outlines, clean shapes",
  oil:          "oil painting style with visible brushwork",
};

function buildPrompt(artStyle, costumeDescription) {
  const styleLine = ART_STYLE_LINES[artStyle] || ART_STYLE_LINES.watercolor;
  return `Treat Image 1 (POSE TEMPLATE) as a paint-by-numbers template. The wooden mannequin in each of its 8 cells defines a POSE and an ANGLE. Your job is to REPLACE the mannequin in each cell with the character from Images 2 and 3 while keeping the mannequin's exact silhouette, pose, and head/body direction unchanged.

Image 2 (STYLED 2×2 AVATAR) — authoritative reference for the costume worn in the bottom row and the art style of the rendering.
Image 3 (CHARACTER PHOTO) — authoritative reference for the face identity.

Output a 2×4 grid with thin black dividing lines and pure white background, same dimensions and cell layout as Image 1.

Cell-by-cell content:
  Cell 1 (top-left): the character's head and neck only, facing the camera straight on. No shoulders, no clothing.
  Cell 2 (top): head and neck only, in the SAME three-quarter angle as Image 1's cell 2 — both eyes still visible, head clearly rotated. No shoulders, no clothing.
  Cell 3 (top): head and neck only, in the SAME profile angle as Image 1's cell 3 — one eye, sharp side silhouette. No shoulders, no clothing.
  Cell 4 (top-right): BACK OF THE HEAD ONLY — the camera is behind the character. The viewer sees the BACK of the hair, the BACK of the neck, and nothing of the face. NO eye, NO nose, NO mouth, NO hat, NO clothing. Match cell 4 of Image 1.
  Cell 5 (bottom-left): full body from head to feet in the costume — ${costumeDescription}. Every costume element from Image 2 (especially headwear if Image 2 shows one) must be present here. Facing the camera straight on.
  Cell 6 (bottom): full body in the SAME costume, in the SAME three-quarter angle as Image 1's cell 6 — leading shoulder forward, both feet visible, chest partly facing the viewer. Same hat and accessories as cell 5.
  Cell 7 (bottom): full body in the SAME costume, in the SAME profile angle as Image 1's cell 7. Same hat and accessories as cell 5.
  Cell 8 (bottom-right): FULL BODY BACK VIEW — camera is behind the character. The viewer sees the BACK of the costume: back of the hat, back of the shirt, sash tied behind, back of the breeches, back of the boots, heels closer to camera than toes. Match cell 8 of Image 1.

Costume continuity is mandatory: cells 5, 6, 7, and 8 must show the SAME costume worn by the character — every accessory (hat, sash, etc.) visible in cell 5 must also appear in cells 6, 7, and 8.

Render in ${styleLine}. ABSOLUTELY NO TEXT — no numbers, no degree symbols, no labels.`;
}

/**
 * Resolve the character's face photo to a base64 data URI.
 * Handles all the shapes that turn up in this codebase: string, object
 * with .data, photos.face / photos.original / photos.body, etc.
 */
function resolveFacePhoto(character) {
  if (!character) return null;
  const candidates = [
    character.photos?.face,
    character.photos?.original,
    character.photos?.body,
    character.photos?.bodyNoBg,
    character.facePhoto,
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === 'string' && c.startsWith('data:')) return c;
    if (typeof c === 'object' && c.data && c.data.startsWith('data:')) return c.data;
    if (typeof c === 'string' && c.length > 1000) return `data:image/jpeg;base64,${c}`;
  }
  return null;
}

/**
 * Resolve the styled 2×2 costumed avatar for the given clothing key.
 */
function resolveStyled2x2(character, clothingCategory) {
  if (!character?.avatars) return null;
  // Try a handful of fields the production code uses for the costumed 2×2.
  const candidates = [
    character.avatars[clothingCategory],
    character.avatars.costumed?.[clothingCategory?.split(':')[1]],
    character.avatars.costumed,
    character.avatars[`styled_${clothingCategory}`],
    character.avatars.standard,
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === 'string' && c.startsWith('data:')) return c;
    if (typeof c === 'object' && c.data && c.data.startsWith('data:')) return c.data;
    if (typeof c === 'object' && c.imageData && c.imageData.startsWith('data:')) return c.imageData;
  }
  return null;
}

/**
 * Generate a 2×4 reference sheet for one character + costume.
 *
 * @param {Object} character - character record (with .avatars and .photos)
 * @param {Object} opts
 * @param {string} opts.clothingCategory - 'standard' | 'costumed:<theme>' | etc.
 * @param {string} opts.costumeDescription - prose for the costume worn in the bottom row.
 * @param {string} [opts.artStyle='watercolor']
 * @param {Function} [opts.usageTracker] - (provider, usage, fn, modelId) => void
 * @returns {Promise<{ imageData: string, usage: Object }>}
 */
async function generateCharacter2x4Sheet(character, opts = {}) {
  const {
    clothingCategory = 'standard',
    costumeDescription = 'standard outfit',
    artStyle = 'watercolor',
    usageTracker = null,
  } = opts;

  const phantom = loadPhantom();
  const styled2x2 = resolveStyled2x2(character, clothingCategory);
  if (!styled2x2) {
    throw new Error(`No styled 2×2 avatar for ${character?.name || 'character'} (${clothingCategory}). Generate the styled-costumed avatar first.`);
  }
  const facePhoto = resolveFacePhoto(character);
  if (!facePhoto) {
    throw new Error(`No face photo for ${character?.name || 'character'}.`);
  }

  const prompt = buildPrompt(artStyle, costumeDescription);
  log.info(`[CHARACTER 2×4] Generating sheet for ${character?.name} (${clothingCategory}, ${artStyle})`);

  const result = await editWithGrok(prompt, [phantom, styled2x2, facePhoto], {
    aspectRatio: '16:9',
    model: GROK_MODELS.STANDARD,
  });

  if (usageTracker && result.usage) {
    usageTracker('grok', result.usage, 'character_2x4_sheet', result.modelId);
  }

  return { imageData: result.imageData, usage: result.usage };
}

module.exports = {
  generateCharacter2x4Sheet,
  loadPhantom,
  // exposed for tests
  _internal: { buildPrompt, resolveFacePhoto, resolveStyled2x2 },
};
