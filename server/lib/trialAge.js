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

module.exports = { parseTrialAge, applyTrialPhotoTraits, reclampTrialApparentAge, TRIAL_MIN_AGE, TRIAL_MAX_AGE };
