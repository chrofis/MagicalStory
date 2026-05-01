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
 *
 * Avatars + Visual Bible reference images are migrating from inline base64
 * (in characters.data and stories.data) to R2. The loaders below return base64
 * regardless of where the bytes physically live — checking the *Url field
 * first (R2), falling back to the inline base64 (legacy). Callers stay
 * shape-agnostic during the migration.
 */

const { fetchImageBytes } = require('./r2');

const _avatarFetchCache = new Map();
async function _getOrFetch(url) {
  if (!url) return null;
  if (_avatarFetchCache.has(url)) return _avatarFetchCache.get(url);
  const bytes = await fetchImageBytes(url);
  if (bytes) _avatarFetchCache.set(url, bytes);
  return bytes;
}

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

/**
 * Load avatar bytes for a slot. Prefers the R2 URL field if set (newer
 * shape, post-migration), falls back to the inline base64 string (legacy
 * shape, pre-migration). Returns base64 string suitable for sharp/Buffer
 * decode, or null when nothing is available.
 *
 * Avatar object shape (post-migration target):
 *   {
 *     status, generatedAt, clothing,
 *     standard: null,                 // legacy inline base64 (post-migration: nulled)
 *     standardUrl: 'https://…/standard.jpg',
 *     summer / summerUrl, winter / winterUrl,
 *     styledAvatars: { …Url fields },
 *     bodyThumbnails / faceThumbnails: { …Url fields },
 *   }
 *
 * @param {Object} avatar - The avatars object from character.avatars
 * @param {string} slot   - 'standard' | 'summer' | 'winter'
 * @returns {Promise<string|null>} base64 string (no data: prefix) or null
 */
async function loadAvatarBytes(avatar, slot) {
  if (!avatar || !slot) return null;
  const url = avatar[`${slot}Url`];
  if (url) {
    const b = await _getOrFetch(url);
    if (b) return b;
    // R2 fetch failed — fall through to inline if present (defense in depth)
  }
  const inline = avatar[slot];
  if (typeof inline === 'string' && inline.length > 0) {
    return inline.replace(/^data:image\/\w+;base64,/, '');
  }
  return null;
}

/**
 * Load Visual Bible reference image bytes. Same dual-shape pattern as
 * loadAvatarBytes — prefers `referenceImageUrl` (R2), falls back to
 * `referenceImageData` (legacy inline base64).
 *
 * VB entry shape (post-migration target):
 *   {
 *     id, name, extractedDescription, ...,
 *     referenceImageData: null,
 *     referenceImageUrl: 'https://…/vb/ART003.jpg'
 *   }
 *
 * @param {Object} vbEntry - A single VB entry (character/animal/artifact/etc.)
 * @returns {Promise<string|null>} base64 string (no data: prefix) or null
 */
async function loadVbReferenceBytes(vbEntry) {
  if (!vbEntry) return null;
  if (vbEntry.referenceImageUrl) {
    const b = await _getOrFetch(vbEntry.referenceImageUrl);
    if (b) return b;
  }
  const inline = vbEntry.referenceImageData;
  if (typeof inline === 'string' && inline.length > 0) {
    return inline.replace(/^data:image\/\w+;base64,/, '');
  }
  return null;
}

module.exports = {
  getPhoto,
  getPrimaryPhoto,
  getFacePhoto,
  hasPhotos,
  normalizePhotos,
  stripLegacyPhotoFields,
  normalizeAllPhotos,
  loadAvatarBytes,
  loadVbReferenceBytes,
};
