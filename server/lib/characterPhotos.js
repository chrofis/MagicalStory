/**
 * Character Photo Helpers
 *
 * Single source of truth for reading character photos.
 * Handles normalization of legacy field formats to the canonical structure:
 *
 * character.photos = {
 *   original: string,   // Full uploaded photo (data URI)
 *   face: string,       // Cropped face
 *   body: string,       // Cropped body
 *   bodyNoBg: string,   // Body with background removed
 *   faceBox?: BoundingBox,
 *   bodyBox?: BoundingBox
 * }
 */

/**
 * Get a specific photo type from a character
 * @param {Object} character - Character object
 * @param {string} type - Photo type: 'original', 'face', 'body', 'bodyNoBg'
 * @returns {string|null} Photo data URI or null
 */
function getPhoto(character, type = 'face') {
  if (!character) return null;
  return character.photos?.[type] || null;
}

/**
 * Get the best available photo for a character (prefers body without background)
 * Used for image generation reference photos
 * @param {Object} character - Character object
 * @returns {string|null} Photo data URI or null
 */
function getPrimaryPhoto(character) {
  if (!character) return null;

  // First check normalized photos structure
  const photos = character.photos;
  if (photos?.bodyNoBg || photos?.body || photos?.face || photos?.original) {
    return photos.bodyNoBg || photos.body || photos.face || photos.original;
  }

  // Fallback to legacy fields (for unmigrated data)
  return character.body_no_bg_url || character.bodyNoBgUrl
      || character.body_photo_url || character.bodyPhotoUrl
      || character.photo_url || character.photoUrl || character.photo
      || null;
}

/**
 * Get the face photo for a character (for face matching, avatar generation)
 * @param {Object} character - Character object
 * @returns {string|null} Photo data URI or null
 */
function getFacePhoto(character) {
  if (!character) return null;

  // First check normalized photos structure
  const photos = character.photos;
  if (photos?.face || photos?.original) {
    return photos.face || photos.original;
  }

  // Fallback to legacy fields (for unmigrated data)
  return character.thumbnail_url || character.photo_url || character.photoUrl || character.photo || null;
}

/**
 * Check if a character has any photos
 * @param {Object} character - Character object
 * @returns {boolean} True if character has at least one photo
 */
function hasPhotos(character) {
  if (!character) return false;

  // Check normalized photos structure
  const p = character.photos;
  if (p?.original || p?.face || p?.body || p?.bodyNoBg) {
    return true;
  }

  // Check legacy fields (for unmigrated data)
  return !!(character.photo_url || character.photoUrl || character.photo ||
            character.thumbnail_url || character.body_photo_url || character.body_no_bg_url);
}

/**
 * Normalize legacy photo fields to the canonical photos.* structure
 * This is a migration helper - normalizes data on read for backwards compatibility.
 *
 * Legacy fields supported:
 * - photo_url, photoUrl, photo -> photos.original
 * - thumbnail_url -> photos.face
 * - body_photo_url -> photos.body
 * - body_no_bg_url -> photos.bodyNoBg
 * - face_box, faceBox -> photos.faceBox
 * - body_box, bodyBox -> photos.bodyBox
 *
 * @param {Object} character - Character object (mutated in place)
 * @returns {Object} The same character object with normalized photos
 */
function normalizePhotos(character) {
  if (!character) return character;

  // Already has normalized photos structure with data
  if (character.photos?.original || character.photos?.face ||
      character.photos?.body || character.photos?.bodyNoBg) {
    return character;
  }

  // Check if there are any legacy fields to migrate
  const hasLegacyFields = character.photo_url || character.photoUrl || character.photo ||
                          character.thumbnail_url || character.body_photo_url || character.body_no_bg_url;

  if (!hasLegacyFields) {
    return character;
  }

  // Migrate from legacy fields
  character.photos = {
    original: character.photo_url || character.photoUrl || character.photo || null,
    face: character.thumbnail_url || null,
    body: character.body_photo_url || null,
    bodyNoBg: character.body_no_bg_url || null,
    faceBox: character.face_box || character.faceBox || null,
    bodyBox: character.body_box || character.bodyBox || null
  };

  return character;
}

/**
 * Strip legacy photo fields from a character (after migration)
 * Call this when saving to ensure only the canonical structure is stored.
 * @param {Object} character - Character object (mutated in place)
 * @returns {Object} The same character object with legacy fields removed
 */
function stripLegacyPhotoFields(character) {
  if (!character) return character;

  delete character.photo_url;
  delete character.photoUrl;
  delete character.photo;
  delete character.thumbnail_url;
  delete character.body_photo_url;
  delete character.body_no_bg_url;
  delete character.face_box;
  delete character.bodyPhotoUrl;
  delete character.bodyNoBgUrl;

  return character;
}

/**
 * Normalize all characters in an array
 * @param {Array} characters - Array of character objects
 * @returns {Array} The same array with all characters normalized
 */
function normalizeAllPhotos(characters) {
  if (!Array.isArray(characters)) return characters;
  characters.forEach(normalizePhotos);
  return characters;
}

module.exports = {
  getPhoto,
  getPrimaryPhoto,
  getFacePhoto,
  hasPhotos,
  normalizePhotos,
  stripLegacyPhotoFields,
  normalizeAllPhotos
};
