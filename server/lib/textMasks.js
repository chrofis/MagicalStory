/**
 * Text area mask loader — pre-built PNGs from assets/masks/
 *
 * Masks are generated once by scripts/build-text-masks.js and loaded into memory
 * at module import. Each mask is a black PNG with a white (blurred) region showing
 * where story text will be placed. Sent to image models as a reference so they
 * keep that region calm and light.
 */

const path = require('path');
const fs = require('fs');
const { log } = require('../utils/logger');

const MASKS_DIR = path.join(__dirname, '..', '..', 'assets', 'masks');

// In-memory cache of loaded masks
const masks = {};

function loadMasks() {
  if (!fs.existsSync(MASKS_DIR)) {
    log.warn(`⚠️ [TEXT-MASKS] Directory not found: ${MASKS_DIR} — run scripts/build-text-masks.js`);
    return;
  }
  const files = fs.readdirSync(MASKS_DIR).filter(f => f.startsWith('text-mask-') && f.endsWith('.png'));
  for (const file of files) {
    const key = file.replace(/^text-mask-/, '').replace(/\.png$/, ''); // e.g. "top-right-medium"
    const buf = fs.readFileSync(path.join(MASKS_DIR, file));
    masks[key] = `data:image/png;base64,${buf.toString('base64')}`;
  }
  log.info(`✅ [TEXT-MASKS] Loaded ${Object.keys(masks).length} pre-built text area masks`);
}

loadMasks();

/**
 * Get a text area mask by position and reading level.
 * @param {string} textPosition - e.g. 'top-right', 'bottom-full'
 * @param {string} langLevel - '1st-grade' | 'standard' | 'advanced'
 * @returns {string|null} - base64 data URI of the mask PNG, or null if not found
 */
function getTextAreaMask(textPosition, langLevel = 'standard') {
  if (!textPosition) return null;
  const sizeName = langLevel === '1st-grade' ? 'small'
    : langLevel === 'advanced' ? 'large'
    : 'medium';
  const key = `${textPosition}-${sizeName}`;
  const mask = masks[key];
  if (!mask) {
    log.warn(`⚠️ [TEXT-MASKS] No mask for "${key}" — falling back to null`);
    return null;
  }
  return mask;
}

module.exports = { getTextAreaMask };
