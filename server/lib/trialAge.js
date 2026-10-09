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
  // drop it for a declared child (promptBuilders.facialHairForAge). Same key the regular path's
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
 * The plain "standard" avatar the trial shows before the story (the preview
 * avatar, routes/trial.js generate-preview-avatar) — and the sheet the story
 * later uses as the character's standard look. Its age line used to be an
 * ad-hoc label (`<=5 toddler`, `<=8 young child`) with no number: a 5-year-old
 * was called a "toddler" and a 7-year-old (Lily, staging
 * job_1791500208126_at0wow7xa) a "young child", and the picture came back about
 * four. The age is now the declared years plus the shared proportion markers
 * (getAgeCategory/getAgeMarkers — the line every sheet prompt already uses via
 * character2x4Sheet.declaredAgeBlock), so one table decides how old a child is
 * drawn. decisions.md 2026-10-09.
 *
 * @param {{age: number, isFemale: boolean, hairDescription?: string, standardClothing: string}} p
 * @returns {string}
 */
function buildTrialPreviewAvatarPrompt({ age, isFemale, hairDescription = '', standardClothing }) {
  const { getAgeCategory, getAgeMarkers } = require('./promptBuilders');
  const genderWord = isFemale ? 'girl' : 'boy';
  const markers = getAgeMarkers(getAgeCategory(age));
  const ageLine = markers
    ? `
- AGE: ${age} years old — ${markers}. The stated age decides the proportions; the figure is never drawn younger or smaller than it.`
    : `
- AGE: ${age} years old; the figure is never drawn younger or smaller than that.`;
  const hairInstruction = hairDescription
    ? `
- HAIR: ${hairDescription}. Reproduce this EXACTLY — do not change length, color, or style.`
    : '';
  return `Create a full-body watercolor illustration of this ${age}-year-old ${genderWord} as a children's book character.

REFERENCE: The attached photo shows the child's face. Match their facial features, skin tone, eye color, and hair color/style EXACTLY.
- Biometric precision: The face must not be averaged or replaced.
- Hair and face must be fully visible. Avoid hats and hoods.
- Ultra-sharp focus on facial features.${ageLine}${hairInstruction}

STYLE: Soft watercolor illustration style for a children's storybook. Warm, friendly, age-appropriate.

POSE: Standing naturally, facing slightly toward the viewer, with a warm smile. Full body visible from head to feet.

CLOTHING: ${standardClothing}

BACKGROUND: Simple, clean white or very light watercolor wash background.

OUTPUT: A single character illustration. No text, no borders, no additional elements.`;
}

module.exports = { buildTrialPreviewAvatarPrompt, parseTrialAge, applyTrialPhotoTraits, reclampTrialApparentAge, TRIAL_MIN_AGE, TRIAL_MAX_AGE };
