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

function buildPrompt(artStyle, costumeDescription) {
  return `Image 1 indicates only the camera angle and facing direction in each cell — ignore its silhouette, body, and face.
Image 2 is the character's body. Image 3 is the character's face.

Costume: ${costumeDescription}

Output a 2×4 grid with thin black dividing lines and pure white background, in the same cell layout as Image 1.

Cells 1-4 (top row): head and neck only, no shoulders, no clothing. Cell 1 front, cell 2 three-quarter, cell 3 profile, cell 4 back of head.
Cells 5-8 (bottom row): full body from head to feet wearing the costume. Cell 5 front, cell 6 three-quarter, cell 7 profile, cell 8 back.

Every cell faces in the same direction as the matching cell in Image 1. The same costume — every accessory — appears in cells 5, 6, 7, and 8. No text, no numbers, no labels.`;
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
 * Resolve the character's base standard avatar (the Grok-generated single-shot
 * body avatar produced by the clothing-avatars pipeline). This is the body /
 * identity reference fed to the 2×4 generator. No more styled-2×2 middleman.
 *
 * Returns a data URI / R2 URL string, or null when the standard avatar is
 * missing — the caller can fall back to the face photo alone.
 */
function resolveStandardAvatar(character) {
  if (!character?.avatars) return null;
  const v = character.avatars.standard;
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.imageUrl || v.imageData || v.data || null;
  return null;
}

/**
 * Generate a 2×4 reference sheet for one character + costume in one Grok call.
 *
 * Inputs to Grok: phantom (pose template) + standard avatar (body / clothing
 * identity) + face photo (face identity). No Gemini styled-2×2 step — the 2×4
 * IS the styled avatar.
 *
 * @param {Object} character - character record (with .avatars and .photos)
 * @param {Object} opts
 * @param {string} opts.clothingCategory - 'standard' | 'costumed:<theme>' | 'winter' | 'summer'
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
  const facePhoto = resolveFacePhoto(character);
  if (!facePhoto) {
    throw new Error(`No face photo for ${character?.name || 'character'}.`);
  }
  const standardAvatar = resolveStandardAvatar(character);
  // The standard avatar is the preferred body reference. If it's missing
  // (e.g. avatar generation failed earlier), fall back to face-only —
  // Grok will rebuild the body from the prompt.
  const refs = standardAvatar
    ? [phantom, standardAvatar, facePhoto]
    : [phantom, facePhoto];

  const prompt = buildPrompt(artStyle, costumeDescription);
  log.info(`[CHARACTER 2×4] Generating sheet for ${character?.name} (${clothingCategory}, ${artStyle}, refs=${refs.length})`);

  const result = await editWithGrok(prompt, refs, {
    aspectRatio: '16:9',
    model: GROK_MODELS.STANDARD,
  });

  if (usageTracker && result.usage) {
    usageTracker('grok', result.usage, 'character_2x4_sheet', result.modelId);
  }

  return {
    imageData: result.imageData,
    usage: result.usage,
    prompt,
    refs: {
      phantom,
      standardAvatar: standardAvatar || null,
      facePhoto,
    },
  };
}

module.exports = {
  generateCharacter2x4Sheet,
  loadPhantom,
  // exposed for tests
  _internal: { buildPrompt, resolveFacePhoto, resolveStandardAvatar },
};
