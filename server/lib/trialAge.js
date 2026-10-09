/**
 * The trial's declared age — ONE parser for every trial entry point.
 *
 * Owner ruling, 2026-09-15: "The age must be made mandatory in the trial run,
 * otherwise this will not work."
 *
 * Why it became load-bearing: de8753cc1 made the USER-ENTERED age the single
 * source for both halves of the avatar loop — the generator builds the body for
 * the declared age (`ageLine`) and the judge scores age against that same
 * declaration (`ageFact`), via resolveDeclaredAvatarOverrides
 * (server/lib/avatarOverrides.js). With no age on the character row that chain
 * emits nothing: the trial character silently falls back to the generic phantom
 * tier (character2x4Sheet.phantomTierForAge → 'child') and to the pre-de8753cc1
 * behaviour the ruling removed. The age also drives the age-band plot rules
 * (AGE_BANDS / focusAge) and the topic age windows (TOPIC_AGE_WINDOWS).
 *
 * Range: whole years 1-18. The trial has rejected anything outside 1-18 since
 * it shipped and this change only makes the field REQUIRED — it does not widen
 * the accepted input. Age 0 stays rejected here deliberately: the downstream
 * band machinery does accept it (`youngestMainAge` filters `n >= 0`,
 * AGE_BANDS[0] = 'routine'), but the trial funnel has never offered a
 * newborn hero and admitting one is a separate product decision, not a
 * side effect of making the field mandatory.
 */

const { clampApparentAge } = require('./promptBuilders');

const TRIAL_MIN_AGE = 1;
const TRIAL_MAX_AGE = 18;

/**
 * @param {unknown} age  raw client input (the trial form sends a string)
 * @returns {{ok: true, years: number} | {ok: false, error: string}}
 */
function parseTrialAge(age) {
  if (age === null || age === undefined || String(age).trim() === '') {
    return { ok: false, error: 'Age is required' };
  }
  const raw = String(age).trim();
  // Whole years only — "7.5" or "7 Jahre" is not a value this form can produce,
  // and guessing at one would put an age on the row the user never declared.
  if (!/^\d{1,3}$/.test(raw)) return { ok: false, error: 'Invalid age' };
  const years = parseInt(raw, 10);
  if (!Number.isFinite(years) || years < TRIAL_MIN_AGE || years > TRIAL_MAX_AGE) {
    return { ok: false, error: 'Invalid age' };
  }
  return { ok: true, years };
}

/**
 * Copy the photo-analysis traits onto a trial character's `physical`, with the
 * photo's apparentAge CLAMPED to within one age group of the declared age —
 * the same clampApparentAge() the regular avatar paths apply
 * (routes/avatars.js). extractCharacterVisualProfile trusts
 * `physical.apparentAge` over the declared age precisely because that clamp
 * bounds it, so an unclamped write lets an adult's photo on a 5-year-old
 * character draw the story's pages as an adult ("adult proportions",
 * "middle-aged man").
 *
 * Every trial writer of photo traits goes through here: the preview-avatar
 * save and the create-anonymous-account background save.
 *
 * @param {Object} physical   the character's physical object (mutated)
 * @param {Object} traits     extracted traits (may carry `confidence`)
 * @param {string|number} statedAge  the age currently on the character row
 * @returns {{clamp: Object|null}} the clamp result for logging
 */
function applyTrialPhotoTraits(physical, traits, statedAge) {
  if (traits.hairColor) physical.hairColor = traits.hairColor;
  if (traits.eyeColor) physical.eyeColor = traits.eyeColor;
  if (traits.skinTone) physical.skinTone = traits.skinTone;
  if (traits.detailedHairAnalysis) physical.detailedHairAnalysis = traits.detailedHairAnalysis;
  // The photo's glasses and recorded features (prompts/character-analysis.txt
  // returns `glasses` and `distinctive markings`; the regular avatar path maps
  // the latter to `other`, routes/avatars.js). Stored raw, 'none' included, as
  // that path stores them: every reader (avatarOverrides.declaredGlasses,
  // promptBuilders.recordedFeatures / extractCharacterVisualProfile) drops a
  // 'none' itself. Until 2026-10-07 the trial never stamped either, so the
  // sheet generator's glasses line, both row judges' glasses check and the
  // page prompt's DISTINCTIVE FEATURES block were empty on every trial.
  if (traits.glasses) physical.glasses = traits.glasses;
  // Facial hair has its own field (character-analysis.txt) so it never lands in `other`; the readers
  // drop it for a declared child (characterPhysical.plausiblePhysical). Same key the regular path's
  // consensus stores (routes/avatars.js).
  if (traits.facialHair) physical.facialHair = traits.facialHair;
  const other = traits.other || traits['distinctive markings'];
  if (other) physical.other = other;
  let clamp = null;
  if (traits.apparentAge) {
    clamp = clampApparentAge(traits.apparentAge, statedAge, traits.confidence?.overallConfidence || null);
    physical.apparentAge = clamp.category;
  }
  return { clamp };
}

/**
 * Re-bound a stored apparentAge against a (possibly changed) declared age.
 * The trial wizard syncs an age edited after the prewarm through
 * update-character-details; the stored apparentAge was clamped against the OLD
 * age and must stay within one group of the NEW one. Idempotent when the age
 * did not change (a clamped value is already within one group).
 *
 * @returns {Object|null} the clamp result, or null when there is nothing to clamp
 */
function reclampTrialApparentAge(physical, statedAge) {
  if (!physical?.apparentAge) return null;
  const clamp = clampApparentAge(physical.apparentAge, statedAge);
  physical.apparentAge = clamp.category;
  return clamp;
}

/**
 * The photo analysis's own estimate of who is in the photo: the apparentAge category and the gender, from the traits
 * the trial already extracts (prompts/character-analysis.txt). Gender is kept only when it is male or female ('other' or
 * missing is no estimate). Stored on the character row as `photoEstimate` so the standard avatar's body row can be
 * drawn at the photo, before the visitor has typed an age or a gender (docs/decisions.md 2026-10-09).
 * @returns {{apparentAge: string|null, gender: string}|null} null when the photo analysis gave neither
 */
function photoEstimateOf(traits) {
  if (!traits) return null;
  const apparentAge = typeof traits.apparentAge === 'string' && traits.apparentAge.trim() ? traits.apparentAge.trim() : null;
  const g = String(traits.gender || '').trim().toLowerCase();
  const gender = g === 'male' || g === 'female' ? g : '';
  if (!apparentAge && !gender) return null;
  return { apparentAge, gender };
}

/**
 * The whole-year age that stands for an age CATEGORY inside the trial's 1-18 range: the middle of the years that
 * getAgeCategory maps to it (rounded up), e.g. kindergartner (5-6) is 6, teenager (15-17) is 16. A category with no year
 * in the range (adult and older) is the top of the range. Used ONLY to draw the body row before an age is declared; the
 * declared age replaces it, and the sheet is restyled only when its band, tier or gender differs.
 * @returns {number|null} null for an unknown category
 */
function representativeTrialAge(category) {
  const { getAgeCategory, getAgeCategoryIndex } = require('./promptBuilders');
  if (getAgeCategoryIndex(category) < 0) return null;
  const years = [];
  for (let y = TRIAL_MIN_AGE; y <= TRIAL_MAX_AGE; y++) if (getAgeCategory(y) === category) years.push(y);
  if (years.length === 0) return TRIAL_MAX_AGE; // every category below the range has a year in it (infant is age 1)
  return Math.ceil((years[0] + years[years.length - 1]) / 2);
}

module.exports = { photoEstimateOf, representativeTrialAge, parseTrialAge, applyTrialPhotoTraits, reclampTrialApparentAge, TRIAL_MIN_AGE, TRIAL_MAX_AGE };
