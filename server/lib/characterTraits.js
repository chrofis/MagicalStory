/**
 * Character Traits Helpers
 *
 * Single source of truth for reading character personality traits.
 * Handles normalization of legacy field formats to the canonical structure:
 *
 * character.traits = {
 *   strengths: string[],
 *   flaws: string[],        // consolidates 'weaknesses'
 *   challenges: string[],   // consolidates 'fears'
 *   specialDetails: string
 * }
 */

// Mapping from legacy field names to canonical names
// Note: multiple legacy fields may map to the same canonical field
const FIELD_MAPPINGS = {
  strengths: 'strengths',
  weaknesses: 'flaws',
  flaws: 'flaws',
  fears: 'challenges',
  challenges: 'challenges',
  special_details: 'specialDetails',
  specialDetails: 'specialDetails'
};

// All legacy field names to strip (flat fields at character level)
const LEGACY_FIELDS = ['strengths', 'weaknesses', 'flaws', 'fears', 'challenges', 'special_details', 'specialDetails'];

/**
 * Ensure value is an array
 * @param {any} value - Value to convert
 * @returns {string[]} Array of strings
 */
function ensureArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  return [];
}

/**
 * Merge arrays, removing duplicates
 * @param {string[]} arr1 - First array
 * @param {string[]} arr2 - Second array
 * @returns {string[]} Merged array without duplicates
 */
function mergeArrays(arr1, arr2) {
  return [...new Set([...ensureArray(arr1), ...ensureArray(arr2)])];
}

/**
 * Get traits from a character
 * Returns the canonical traits object, merging from legacy fields if needed
 * @param {Object} character - Character object
 * @returns {Object} Traits object (never null)
 */
function getTraits(character) {
  if (!character) return { strengths: [], flaws: [], challenges: [], specialDetails: '' };

  // Start with canonical traits object
  const traits = {
    strengths: ensureArray(character.traits?.strengths),
    flaws: ensureArray(character.traits?.flaws),
    challenges: ensureArray(character.traits?.challenges),
    specialDetails: character.traits?.specialDetails || ''
  };

  // Merge from legacy flat fields
  // strengths
  traits.strengths = mergeArrays(traits.strengths, character.strengths);

  // flaws (from weaknesses and flaws)
  traits.flaws = mergeArrays(traits.flaws, character.weaknesses);
  traits.flaws = mergeArrays(traits.flaws, character.flaws);

  // challenges (from fears and challenges)
  traits.challenges = mergeArrays(traits.challenges, character.fears);
  traits.challenges = mergeArrays(traits.challenges, character.challenges);

  // specialDetails
  if (!traits.specialDetails) {
    traits.specialDetails = character.special_details || character.specialDetails || '';
  }

  return traits;
}

/**
 * Get a specific trait array or value
 * @param {Object} character - Character object
 * @param {string} trait - Trait name ('strengths', 'flaws', 'challenges', 'specialDetails')
 * @returns {string[]|string|null} Trait value or empty
 */
function getTrait(character, trait) {
  const traits = getTraits(character);
  return traits[trait] ?? null;
}

/**
 * Check if a character has any traits defined
 * @param {Object} character - Character object
 * @returns {boolean} True if character has at least one trait
 */
function hasTraits(character) {
  if (!character) return false;

  // Check canonical traits object
  const t = character.traits;
  if (t) {
    if (t.strengths?.length > 0) return true;
    if (t.flaws?.length > 0) return true;
    if (t.challenges?.length > 0) return true;
    if (t.specialDetails) return true;
  }

  // Check legacy fields
  if (character.strengths?.length > 0) return true;
  if (character.weaknesses?.length > 0) return true;
  if (character.flaws?.length > 0) return true;
  if (character.fears?.length > 0) return true;
  if (character.challenges?.length > 0) return true;
  if (character.special_details || character.specialDetails) return true;

  return false;
}

/**
 * Normalize legacy trait fields to the canonical traits.* structure
 * This migrates data from flat fields to the traits object.
 *
 * @param {Object} character - Character object (mutated in place)
 * @returns {Object} The same character object with normalized traits
 */
function normalizeTraits(character) {
  if (!character) return character;

  // Get merged traits (handles all legacy fields)
  const merged = getTraits(character);

  // Set canonical structure
  character.traits = merged;

  return character;
}

/**
 * Strip legacy trait fields from a character (after migration)
 * Call this when saving to ensure only the canonical structure is stored.
 * @param {Object} character - Character object (mutated in place)
 * @returns {Object} The same character object with legacy fields removed
 */
function stripLegacyTraitFields(character) {
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
function normalizeAllTraits(characters) {
  if (!Array.isArray(characters)) return characters;
  characters.forEach(normalizeTraits);
  return characters;
}

/**
 * Build a traits description string from character traits
 * Useful for generating prompts
 * @param {Object} character - Character object
 * @returns {string} Human-readable traits description
 */
function buildTraitsDescription(character) {
  const traits = getTraits(character);
  const parts = [];

  if (traits.strengths?.length > 0) {
    parts.push(`Strengths: ${traits.strengths.join(', ')}`);
  }
  if (traits.flaws?.length > 0) {
    parts.push(`Flaws: ${traits.flaws.join(', ')}`);
  }
  if (traits.challenges?.length > 0) {
    parts.push(`Challenges: ${traits.challenges.join(', ')}`);
  }
  if (traits.specialDetails) {
    parts.push(`Special: ${traits.specialDetails}`);
  }

  return parts.join('. ');
}

module.exports = {
  getTraits,
  getTrait,
  hasTraits,
  normalizeTraits,
  stripLegacyTraitFields,
  normalizeAllTraits,
  buildTraitsDescription,
  FIELD_MAPPINGS,
  LEGACY_FIELDS
};
