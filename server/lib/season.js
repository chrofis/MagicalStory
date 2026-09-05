/**
 * Season — ONE resolver, used everywhere.
 *
 * The wizard defaults the season from today's date (`getCurrentSeason()` in
 * client/src/pages/wizard/WizardStep3BookSettings.tsx) and sends it with the
 * job, so a normal story always carries one. Not every launcher does: an admin
 * rerun copies a source job's `input_data` verbatim, and
 * `job_1788614817116_vxnu60yjg` (Uetliberg dragon egg, de-ch, 18 pages) was
 * launched that way with `season: ""`. Every consumer wrote
 * `inputData.season ? \`Season: ${...}\` : null`, so the empty string silently
 * removed the line from the story brief; the UI showed "Jahreszeit: Nicht
 * angegeben", and — because nothing downstream stated a season — page 6 was
 * rendered with autumn-orange foliage while pages 1 and 3 stayed green. The
 * Uetliberg landmark reference photos in the Visual Bible are themselves
 * labelled `[distant, autumn, day]`; with no declared season to repaint them
 * into, the photo's own season won. (Season/weather/light come from the SCENE,
 * never from the landmark photo — decisions.md 2026-08-16.)
 *
 * So: absence is resolved to a deterministic default here, in one place, and
 * the pipeline stamps the result back onto `inputData` before any prompt is
 * built. Northern-hemisphere month boundaries, identical to the client's, so a
 * stamped story and a wizard-launched story agree.
 */

const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

/** Aliases a launcher or an older row might carry. */
const SEASON_ALIASES = {
  fall: 'autumn',
  frühling: 'spring', fruehling: 'spring', printemps: 'spring',
  sommer: 'summer', été: 'summer', ete: 'summer',
  herbst: 'autumn', automne: 'autumn',
  winter: 'winter', hiver: 'winter',
};

/** English label used in prompts. */
const SEASON_LABELS = {
  spring: 'Spring',
  summer: 'Summer',
  autumn: 'Autumn',
  winter: 'Winter',
};

/** Northern hemisphere, same boundaries as the wizard's getCurrentSeason(). */
function seasonForDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const month = Number.isNaN(d.getTime()) ? new Date().getMonth() : d.getMonth(); // 0-11
  if (month >= 2 && month <= 4) return 'spring';   // Mar-May
  if (month >= 5 && month <= 7) return 'summer';   // Jun-Aug
  if (month >= 8 && month <= 10) return 'autumn';  // Sep-Nov
  return 'winter';                                  // Dec-Feb
}

/** Normalise whatever a caller stored to one of SEASONS, or null. */
function normalizeSeason(value) {
  if (!value || typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  if (SEASONS.includes(key)) return key;
  return SEASON_ALIASES[key] || null;
}

/**
 * The story's season. Explicit value wins; otherwise it is derived from the
 * story's own date (job `created_at`), never from "now" at render time — a
 * repair run months later must resolve the same season the pages were drawn in.
 *
 * @param {Object} inputData      story input_data (or story data blob)
 * @param {Object} [opts]
 * @param {Date|string} [opts.now] reference date when no season is given
 * @returns {'spring'|'summer'|'autumn'|'winter'}
 */
function resolveSeason(inputData = {}, { now = null } = {}) {
  return normalizeSeason(inputData?.season)
    || seasonForDate(now || inputData?.createdAt || new Date());
}

/** `Summer` — the label for the story brief / prompt lines. */
function seasonLabel(inputData = {}, opts = {}) {
  return SEASON_LABELS[resolveSeason(inputData, opts)];
}

/**
 * The image-side instruction. Season governs foliage, ground cover and daylight
 * colour across every page, which is exactly the continuity that broke: the
 * same forest path must not be green on one page and orange on the next. It
 * never overrides an indoor page or the page's declared time of day.
 */
function buildSeasonNote(inputData = {}, opts = {}) {
  const label = seasonLabel(inputData, opts);
  if (!label) return '';
  return `**SEASON:** ${label}. Foliage, ground cover, sky and daylight colour are ${label.toLowerCase()}'s throughout the book — identical from page to page for the same place, and matching ${label.toLowerCase()} even when a reference photo was taken in another season. Indoor frames and the page's own time of day are unaffected.`;
}

module.exports = {
  SEASONS,
  SEASON_LABELS,
  seasonForDate,
  normalizeSeason,
  resolveSeason,
  seasonLabel,
  buildSeasonNote,
};
