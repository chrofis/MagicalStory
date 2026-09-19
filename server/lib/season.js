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

/**
 * The TEXT-side instruction: what the writer of the premise/story is told. It
 * constrains DETAIL — light, weather, underfoot, wardrobe — never subject or
 * plot. Stated as a hard fact next to softer neighbours it dominated the
 * premise instead: 24 of 28 rated trial ideas came back as autumn-leaf stories
 * on 2026-09-15, every cell having a distinct setting. Its image-side sibling
 * `buildSeasonNote` still WANTS the visual detail and is unchanged.
 * `buildSeasonNote` is its image-side sibling. Kept here so the trial idea, the
 * trial story and the wizard's two idea endpoints cannot drift apart, and so
 * the season is never welded into another prompt block again (a fantasy idea
 * blanks the location block, which used to blank the season with it —
 * decisions.md 2026-09-09).
 */
function buildSeasonInstruction(inputData = {}, opts = {}) {
  const label = seasonLabel(inputData, opts);
  if (!label) return '';
  return `**SEASON**: It is ${label}. The season shows in the light, the weather, what is underfoot and what the cast wears — in an invented world too. It never decides what the story is about: any subject, any plot, any place can happen in ${label.toLowerCase()}.`;
}

/**
 * The WARDROBE-side instruction: what a character REFERENCE SHEET is told about
 * the outfit. Sibling of `buildSeasonNote` (scenery) and
 * `buildSeasonInstruction` (text), and here for the same reason — one resolver,
 * never a second season notion grown next to this one.
 *
 * It exists because on the trial path NO clothing text reaches any prompt: the
 * contract is `standard: { used: true, signature: 'none' }`, which every
 * resolver discards, so the rendered outfit is whatever the child was
 * photographed in — a summer t-shirt in a winter book, deterministically
 * (staging job_1789296188291_thezv15y1, an autumn story with no clothing word
 * in any of its six scene briefs).
 *
 * Two invariants are baked into the wording:
 *   - it governs GARMENTS only — face, hair, skin tone, build and apparent age
 *     are the identity the sheet exists to anchor and are never touched;
 *   - warm seasons are as explicit as cold ones. A summer story must not gain a
 *     coat merely because the rule says "dress for the season".
 *
 * Footwear rides in its own field: the sheet prompt already owns one footwear
 * rule (`buildFootwearRule`), and a second sentence about shoes would compete
 * with it.
 */
const SEASON_OUTFIT = {
  spring: {
    outfit: 'a light layer — a thin jacket, cardigan or long-sleeved top — over ordinary trousers, a skirt or a dress; nothing heavy, no winter coat',
    footwear: 'closed everyday shoes',
  },
  summer: {
    outfit: 'light warm-weather clothing with short sleeves or bare arms and NO outer layer at all — no coat, jacket, knitwear, scarf or gloves',
    footwear: 'light everyday shoes or sandals',
  },
  autumn: {
    outfit: 'long sleeves under a light outer layer — a jacket, anorak or knit — with long trousers, or a dress or skirt over tights; no bare arms',
    footwear: 'closed everyday shoes',
  },
  winter: {
    outfit: 'a warm outer layer — a padded coat, parka or thick jacket — over long sleeves, with long trousers, or a dress or skirt over thick tights; a hat, scarf or gloves suit it but are not required',
    footwear: 'closed, warm shoes or boots',
  },
};

/**
 * @returns {{season: string, label: string, outfit: string, footwear: string}|null}
 *   null when the story's clothing is not the season's business at all.
 */
function seasonOutfitGuidance(inputData = {}, opts = {}) {
  // Period dress is set by the era, not by this year's weather. The trial
  // premise already blanks the season for `historical` (server/routes/trial.js);
  // the same exclusion belongs here rather than at each caller, so the two
  // cannot drift.
  if (String(inputData?.storyCategory || '').toLowerCase() === 'historical') return null;
  const season = resolveSeason(inputData, opts);
  const guidance = SEASON_OUTFIT[season];
  if (!guidance) return null;
  return { season, label: SEASON_LABELS[season], outfit: guidance.outfit, footwear: guidance.footwear };
}

module.exports = {
  buildSeasonInstruction,
  seasonOutfitGuidance,
  SEASON_OUTFIT,
  SEASONS,
  SEASON_LABELS,
  seasonForDate,
  normalizeSeason,
  resolveSeason,
  seasonLabel,
  buildSeasonNote,
};
