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
 *   other: string
 * }
 */

// Mapping from legacy snake_case fields to canonical camelCase
const FIELD_MAPPINGS = {
  eye_color: 'eyeColor',
  hair_color: 'hairColor',
  hair_style: 'hairStyle',
  hair_length: 'hairLength',
  skin_tone: 'skinTone',
  skin_tone_hex: 'skinToneHex',
  facial_hair: 'facialHair',
  apparent_age: 'apparentAge',
  detailed_hair_analysis: 'detailedHairAnalysis',
  build: 'build',
  other_features: 'other'
};

// All legacy field names to strip
const LEGACY_FIELDS = Object.keys(FIELD_MAPPINGS);

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

/**
 * Build a physical description string from character physical attributes
 * Useful for generating prompts
 * @param {Object} character - Character object
 * @returns {string} Human-readable physical description
 */
function buildPhysicalDescription(character) {
  const physical = getPhysical(character);
  const parts = [];

  if (physical.apparentAge) parts.push(`${physical.apparentAge} years old`);
  if (physical.build) parts.push(physical.build);
  if (physical.skinTone) parts.push(`${physical.skinTone} skin`);
  if (physical.eyeColor) parts.push(`${physical.eyeColor} eyes`);

  // Hair description
  const hairParts = [];
  if (physical.hairLength) hairParts.push(physical.hairLength);
  if (physical.hairStyle) hairParts.push(physical.hairStyle);
  if (physical.hairColor) hairParts.push(physical.hairColor);
  if (hairParts.length) parts.push(`${hairParts.join(' ')} hair`);

  if (physical.facialHair && physical.facialHair !== 'none') {
    parts.push(physical.facialHair);
  }
  if (physical.other) parts.push(physical.other);

  return parts.join(', ');
}

module.exports = {
  getPhysical,
  getPhysicalAttr,
  hasPhysical,
  normalizePhysical,
  stripLegacyPhysicalFields,
  normalizeAllPhysical,
  buildPhysicalDescription,
  FIELD_MAPPINGS,
  LEGACY_FIELDS
};
