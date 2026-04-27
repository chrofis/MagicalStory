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

// Hair-shape fields that the form still writes (CharacterForm has length /
// style / density inputs) but no reader consumes since the d8f177f3
// "single source of truth — detailedHairAnalysis only" refactor. Folded into
// detailedHairAnalysis on save so user edits actually take effect.
const HAIR_SHAPE_FIELD_TO_DETAILED_KEY = {
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

  // Fold + strip CharacterForm's hair-shape fields. The form writes
  // physical.hairLength / physical.hairStyle / physical.hairDensity but
  // since d8f177f3 ("single source of truth — detailedHairAnalysis only")
  // nothing reads them. Without folding, every user hair edit was a write-
  // only zombie. Now: fold each one into the matching detailedHairAnalysis
  // key (lengthTop / styling / density), then drop the top-level field so
  // detailedHairAnalysis stays the single source of truth.
  if (character.physical && typeof character.physical === 'object') {
    const phys = character.physical;
    // Collect non-empty fold candidates BEFORE deciding whether to create a
    // detailedHairAnalysis object. If everything is empty, leave the
    // structure alone — don't fabricate an empty detailed object.
    const folds = {};
    for (const [topField, detailedKey] of Object.entries(HAIR_SHAPE_FIELD_TO_DETAILED_KEY)) {
      const v = phys[topField];
      if (v != null && String(v).trim() !== '') {
        folds[detailedKey] = String(v).trim();
      }
      // Always strip the top-level field — only the canonical structure stays.
      delete phys[topField];
    }
    if (Object.keys(folds).length > 0) {
      const existing = phys.detailedHairAnalysis && typeof phys.detailedHairAnalysis === 'object'
        ? phys.detailedHairAnalysis
        : {};
      phys.detailedHairAnalysis = { ...existing, ...folds };
    }
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
  FIELD_MAPPINGS,
  LEGACY_FIELDS
};
