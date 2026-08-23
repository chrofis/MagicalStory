/**
 * Cover naming domain — single source of truth for the three independent
 * mappings between cover identifiers.
 *
 *   coverKey      — the key under storyData.coverImages AND coverHints:
 *                   'frontCover' | 'initialPage' | 'backCover'
 *   coverType     — short form used by some routes and prompts: 'front' | 'initialPage' | 'back'
 *   coverLabel    — human-readable banner: 'FRONT COVER' | 'INITIAL PAGE' | 'BACK COVER'
 *
 * The third scheme — hintKey, where the front cover's outline hints lived
 * under 'titlePage' — was RETIRED 2026-08-23 (owner: "why do we have 2 names
 * for the same thing"). The outline parser now writes coverHints.frontCover
 * directly and migration 025 renamed the key in every stored story, so
 * coverHints is keyed by coverKey like everything else. The LLM-facing
 * outline section is still titled "Title Page" — the parser translates at
 * that one boundary.
 */

const COVER_KEYS = ['frontCover', 'initialPage', 'backCover'];

// Negative page-number convention for covers — used for log attribution and
// the sanitizeVbIdsInPrompt pageNumber argument. Single source of truth
// (was duplicated as a local constant in coverIterate.js).
const COVER_PAGE_NUMBERS = Object.freeze({
  frontCover: -1,
  initialPage: -2,
  backCover: -3
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
  COVER_PAGE_NUMBERS,
  coverKeyToType,
  coverTypeToKey,
  coverLabel,
};
