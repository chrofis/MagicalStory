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

module.exports = { parseTrialAge, TRIAL_MIN_AGE, TRIAL_MAX_AGE };
