/**
 * Cover naming domain — single source of truth for the three independent
 * mappings between cover identifiers.
 *
 *   coverKey      — the key under storyData.coverImages: 'frontCover' | 'initialPage' | 'backCover'
 *   coverType     — short form used by some routes and prompts: 'front' | 'initialPage' | 'back'
 *   hintKey       — the key under outline coverHints: 'titlePage' | 'initialPage' | 'backCover'
 *   coverLabel    — human-readable banner: 'FRONT COVER' | 'INITIAL PAGE' | 'BACK COVER'
 *
 * Note: 'initialPage' is identical across coverKey, coverType, and hintKey.
 */

const COVER_KEYS = ['frontCover', 'initialPage', 'backCover'];

const COVER_HINT_KEY = Object.freeze({
  frontCover: 'titlePage',
  initialPage: 'initialPage',
  backCover: 'backCover'
});

function coverKeyToType(key) {
  if (key === 'frontCover') return 'front';
  if (key === 'initialPage') return 'initialPage';
  if (key === 'backCover') return 'back';
  return null;
}

function coverTypeToKey(type) {
  if (type === 'front') return 'frontCover';
  if (type === 'initialPage') return 'initialPage';
  if (type === 'back') return 'backCover';
  return null;
}

function coverKeyToHintKey(key) {
  return COVER_HINT_KEY[key] || null;
}

/**
 * Human-readable label for logging. Accepts either a coverKey
 * ('frontCover') or a coverType ('front').
 */
function coverLabel(keyOrType) {
  const key = (keyOrType === 'front' || keyOrType === 'back')
    ? coverTypeToKey(keyOrType)
    : keyOrType;
  if (key === 'frontCover') return 'FRONT COVER';
  if (key === 'initialPage') return 'INITIAL PAGE';
  if (key === 'backCover') return 'BACK COVER';
  return null;
}

module.exports = {
  COVER_KEYS,
  COVER_HINT_KEY,
  coverKeyToType,
  coverTypeToKey,
  coverKeyToHintKey,
  coverLabel,
};
