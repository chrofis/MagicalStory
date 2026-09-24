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

/**
 * Human-readable label for a NEGATIVE page number, or null for a story page.
 * The book audit shows the judge a page number and nothing else, so a cover
 * arrived as a bare "PAGE -3" and was read as a story page in sequence.
 */
function coverLabelForPage(pageNumber) {
  const n = Number(pageNumber);
  if (!Number.isFinite(n) || n >= 0) return null;
  const key = COVER_KEYS.find((k) => COVER_PAGE_NUMBERS[k] === n);
  return key ? coverLabel(key) : null;
}

/**
 * Which covers a job renders. `inputData.coverTypes` is the explicit list
 * (trial: title page + back cover, no dedication page — trials store no
 * dedication); otherwise the legacy `titlePageOnly` boolean decides. One
 * resolver so the start-guard and the start-loop can never disagree.
 */
function coverTypesFor(inputData = {}) {
  if (Array.isArray(inputData.coverTypes) && inputData.coverTypes.length > 0) {
    // Legacy compat: jobs queued before the 2026-08-23 naming unification
    // carry 'titlePage' in coverTypes — normalize at this one boundary.
    // (Was written as `ct === 'frontCover' ? 'frontCover' : ct` — a no-op that
    // mapped the NEW name to itself and let the legacy token through, so a
    // pre-rename queued job's front cover would silently never start.)
    return inputData.coverTypes.map(ct => ct === 'titlePage' ? 'frontCover' : ct);
  }
  return inputData.titlePageOnly
    ? ['frontCover']
    : ['frontCover', 'initialPage', 'backCover'];
}

/**
 * Where each full-story cover's text goes, as a page `textPosition`
 * (covers-as-pages, 2026-09-24). The cover beat states it (coverBeats.js), the
 * Art Director stages it like any page's copy space, the brief check holds the
 * brief to it, and the iterate locks it. A leaf constant, so a script can read it.
 */
const COVER_TEXT_POSITION = Object.freeze({
  frontCover: 'top-full',     // the book title
  initialPage: 'bottom-full', // the dedication
  backCover: 'bottom-full',   // the back-cover line
});

module.exports = {
  COVER_TEXT_POSITION,
  coverTypesFor,
  COVER_KEYS,
  COVER_PAGE_NUMBERS,
  coverKeyToType,
  coverTypeToKey,
  coverLabel,
  coverLabelForPage,
};
