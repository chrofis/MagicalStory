/**
 * Character Physical Traits Helpers
 *
 * Single source of truth for reading character physical attributes.
 * Handles normalization of legacy field formats to the canonical structure:
 *
 * character.physical = {
 *   eyeColor: string,
 *   hairColor: string,
 *   hairStyle: string,
 *   hairLength: string,
 *   skinTone: string,
 *   skinToneHex: string,
 *   facialHair: string,
 *   apparentAge: string,
 *   detailedHairAnalysis: string,
 *   build: string,
 *   face: string,    // Anatomical face shape (age-neutral: jawline, nose, cheeks, lips)
 *   other: string    // Distinguishing marks only (freckles, scars, moles, glasses)
 * }
 *
 * Legacy note: `other_features` used to conflate face shape with distinguishing
 * marks. It now maps to `face` (since historically that's where face data lived).
 * Any character saved before this split gets its face-shape text back into the
 * `face` slot via this mapping.
 */

// Mapping from legacy snake_case fields to canonical camelCase
const FIELD_MAPPINGS = {
  eye_color: 'eyeColor',
  hair_color: 'hairColor',
  hair_style: 'hairStyle',
  hair_length: 'hairLength',
  skin_tone: 'skinTone',
  skin_undertone: 'skinUndertone',
  skin_tone_hex: 'skinToneHex',
  facial_hair: 'facialHair',
  apparent_age: 'apparentAge',
  detailed_hair_analysis: 'detailedHairAnalysis',
  build: 'build',
  face: 'face',
  // Legacy: `other_features` historically stored face-shape descriptions.
  // Route it to `face` so existing characters keep their data in the right slot.
  other_features: 'face',
  other: 'other',
  glasses: 'glasses'
};

// All legacy field names to strip
const LEGACY_FIELDS = Object.keys(FIELD_MAPPINGS);

// Hair-shape fields the CharacterForm writes when the user picks from the
// length / style / density dropdowns. These are USER OVERRIDES — they do
// NOT mix into the auto-extracted detailedHairAnalysis (which would let one
// pollute the other). They live in their own sub-object physical.userHairOverride
// that wins over detailedHairAnalysis at read time.
//
// After a successful avatar regeneration, the new avatar gets re-analysed and
// the fresh detailedHairAnalysis replaces the old one. At that point
// userHairOverride is cleared because the canonical extraction now agrees
// with what the user wanted.
const HAIR_OVERRIDE_FIELD_TO_DETAILED_KEY = {
  hairLength: 'lengthTop',
  hairStyle: 'styling',
  hairDensity: 'density',
};

/**
 * Get physical attributes from a character
 * Returns the canonical physical object, merging from legacy fields if needed
 * @param {Object} character - Character object
 * @returns {Object} Physical attributes object (never null)
 */
function getPhysical(character) {
  if (!character) return {};

  // Start with canonical physical object
  const physical = { ...(character.physical || {}) };

  // Fill in from legacy fields if canonical fields are missing
  for (const [legacy, canonical] of Object.entries(FIELD_MAPPINGS)) {
    if (!physical[canonical] && character[legacy]) {
      physical[canonical] = character[legacy];
    }
  }

  return physical;
}

/**
 * Get a specific physical attribute
 * @param {Object} character - Character object
 * @param {string} attr - Attribute name (camelCase)
 * @returns {string|null} Attribute value or null
 */
function getPhysicalAttr(character, attr) {
  if (!character) return null;

  // Check canonical location first
  if (character.physical?.[attr]) {
    return character.physical[attr];
  }

  // Find the legacy field name for this attribute
  const legacyField = Object.entries(FIELD_MAPPINGS).find(([, v]) => v === attr)?.[0];
  if (legacyField && character[legacyField]) {
    return character[legacyField];
  }

  return null;
}

/**
 * Check if a character has any physical attributes
 * @param {Object} character - Character object
 * @returns {boolean} True if character has at least one physical attribute
 */
function hasPhysical(character) {
  if (!character) return false;

  // Check canonical physical object
  const p = character.physical;
  if (p && Object.values(p).some(v => v)) {
    return true;
  }

  // Check legacy fields
  return LEGACY_FIELDS.some(field => character[field]);
}

/**
 * Normalize legacy physical fields to the canonical physical.* structure
 * This migrates data from flat snake_case fields to the physical object.
 *
 * @param {Object} character - Character object (mutated in place)
 * @returns {Object} The same character object with normalized physical
 */
function normalizePhysical(character) {
  if (!character) return character;

  // Initialize physical object if needed
  if (!character.physical) {
    character.physical = {};
  }

  // Migrate legacy fields to canonical structure
  for (const [legacy, canonical] of Object.entries(FIELD_MAPPINGS)) {
    // Only migrate if canonical field is empty and legacy has value
    if (!character.physical[canonical] && character[legacy]) {
      character.physical[canonical] = character[legacy];
    }
  }

  return character;
}

/**
 * Strip legacy physical fields from a character (after migration)
 * Call this when saving to ensure only the canonical structure is stored.
 * @param {Object} character - Character object (mutated in place)
 * @returns {Object} The same character object with legacy fields removed
 */
function stripLegacyPhysicalFields(character) {
  if (!character) return character;

  for (const field of LEGACY_FIELDS) {
    delete character[field];
  }

  // Move the form's hair-shape inputs into physical.userHairOverride.
  // CharacterForm writes physical.hairLength / hairStyle / hairDensity from
  // its dropdowns. Those are USER OVERRIDES — they belong in their own
  // sub-object so they never blend into the auto-extracted
  // detailedHairAnalysis. buildHairDescription reads override-first, falls
  // back to detailedHairAnalysis when no override is present.
  if (character.physical && typeof character.physical === 'object') {
    const phys = character.physical;
    const overrides = {};
    for (const [topField, detailedKey] of Object.entries(HAIR_OVERRIDE_FIELD_TO_DETAILED_KEY)) {
      const v = phys[topField];
      if (v != null && String(v).trim() !== '') {
        overrides[detailedKey] = String(v).trim();
      }
      // Strip the top-level field unconditionally — the canonical home is
      // physical.userHairOverride.
      delete phys[topField];
    }
    if (Object.keys(overrides).length > 0) {
      const existing = phys.userHairOverride && typeof phys.userHairOverride === 'object'
        ? phys.userHairOverride
        : {};
      phys.userHairOverride = { ...existing, ...overrides };
    }
  }

  return character;
}

/**
 * Helper: did the user explicitly override any hair field? Used at avatar-
 * generation time to decide whether to send PHYSICAL TRAIT CORRECTIONS for
 * hair to Gemini.
 */
function hasUserHairOverride(physical) {
  const o = physical?.userHairOverride;
  return o && typeof o === 'object' && Object.keys(o).length > 0;
}

/**
 * Inverse of the fold inside stripLegacyPhysicalFields: copies
 * physical.userHairOverride.{lengthTop,styling,density} back to
 * physical.{hairLength,hairStyle,hairDensity} on the character object.
 *
 * Used when SHAPING API RESPONSES for the CharacterForm UI. The form's
 * dropdowns bind to physical.hairLength / hairStyle, which storage no
 * longer has — they live in userHairOverride. Without this expansion the
 * form loads empty after a save round-trip even though the value WAS
 * persisted.
 *
 * Pure read-side helper. Storage stays canonical (override-in-sub-object).
 * Only mutates the character passed in so caller can map() over a list.
 */
function expandUserHairOverrideForDisplay(character) {
  if (!character || !character.physical || typeof character.physical !== 'object') return character;
  const o = character.physical.userHairOverride;
  if (!o || typeof o !== 'object') return character;
  for (const [topField, detailedKey] of Object.entries(HAIR_OVERRIDE_FIELD_TO_DETAILED_KEY)) {
    const v = o[detailedKey];
    if (v != null && String(v).trim() !== '') {
      character.physical[topField] = String(v);
    }
  }
  return character;
}

/**
 * Clear physical.userHairOverride. Called by the avatar pipeline AFTER a
 * successful regeneration + re-analysis: the fresh detailedHairAnalysis now
 * reflects what the user wanted, so the override is no longer needed.
 */
function clearUserHairOverride(character) {
  if (character?.physical?.userHairOverride) {
    delete character.physical.userHairOverride;
  }
  return character;
}

/**
 * Normalize all characters in an array
 * @param {Array} characters - Array of character objects
 * @returns {Array} The same array with all characters normalized
 */
function normalizeAllPhysical(characters) {
  if (!Array.isArray(characters)) return characters;
  characters.forEach(normalizePhysical);
  return characters;
}

module.exports = {
  getPhysical,
  getPhysicalAttr,
  hasPhysical,
  normalizePhysical,
  stripLegacyPhysicalFields,
  normalizeAllPhysical,
  hasUserHairOverride,
  clearUserHairOverride,
  expandUserHairOverrideForDisplay,
  FIELD_MAPPINGS,
  LEGACY_FIELDS
};
