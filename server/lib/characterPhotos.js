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
 * Avatars + Visual Bible reference images live on Cloudflare R2. The loaders
 * below fetch the bytes from the public R2 URL stored in the *Url / *ImageUrl
 * field and return base64 ready for sharp/Buffer decode.
 */

const { fetchImageBytes } = require('./r2');

const _avatarFetchCache = new Map();
async function _getOrFetch(url) {
  if (!url) return null;
  if (_avatarFetchCache.has(url)) return _avatarFetchCache.get(url);
  const buf = await fetchImageBytes(url);
  if (!buf) return null;
  // fetchImageBytes returns Buffer; loaders below contract base64 string.
  const b64 = buf.toString('base64');
  _avatarFetchCache.set(url, b64);
  return b64;
}

// ---------------------------------------------------------------------------
// Dual-shape readers for the character-photo-fields migration (Phase 1)
// ---------------------------------------------------------------------------
// During the staged migration we have rows in BOTH shapes:
//
//   OLD shape                          NEW shape (post-migration)
//   ─────────────                      ────────────────────────────
//   avatars.standardUrl  (R2 URL)      avatars.standard (URL string)
//   avatars.standard     (inline /    │      ↑
//                         object)     │      (URL string only; inline form gone)
//   avatars.faceThumbnailsUrl.{v}     avatars.faceThumb.{v}
//   avatars.faceThumbnails.{v}              ↑
//                                     (URL string, single field)
//   avatars.bodyThumbnailsUrl.{v}     avatars.bodyThumb.{v}
//   avatars.bodyThumbnails.{v}
//
// These helpers read NEW first, then fall back to OLD. They always return a
// URL string (or null) — never an object, never a Buffer. Inline data: URIs
// are returned as-is when that's all there is, so caller can still decode.
// ---------------------------------------------------------------------------

/**
 * Pull a usable URL string out of a value that might be:
 *  - a plain string (URL or data: URI)
 *  - an object like { url, imageUrl, src, dataUri, imageData, data, image }
 *  - null / undefined / "" / non-string non-object
 * Returns a string or null. Never returns the object or Buffer.
 */
function _toUrlString(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const t = value.trim();
    return t || null;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const keys = ['url', 'imageUrl', 'src', 'dataUri', 'imageData', 'data', 'image'];
    for (const k of keys) {
      const v = value[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

/**
 * Get the main avatar URL for a clothing variant.
 * Reads NEW shape `avatars.{variant}` (URL string), falls back to OLD
 * shape `avatars.{variant}Url` or `avatars.{variant}` (inline / object).
 *
 * @param {Object} character - character object (or an avatars sub-object —
 *                             we accept both for ergonomics)
 * @param {string} variant   - 'standard' | 'winter' | 'summer'
 * @returns {string|null}    - URL string, data: URI, or null
 */
function getStandardAvatar(character, variant = 'standard') {
  if (!character) return null;
  // Accept either a character or an avatars object directly
  const avatars = character.avatars && typeof character.avatars === 'object'
    ? character.avatars
    : character;
  if (!avatars || typeof avatars !== 'object') return null;
  // NEW shape first: avatars.{variant} is a URL string
  const newVal = _toUrlString(avatars[variant]);
  if (newVal) return newVal;
  // OLD shape: avatars.{variant}Url
  const oldUrl = _toUrlString(avatars[`${variant}Url`]);
  if (oldUrl) return oldUrl;
  return null;
}

/**
 * Get the face-thumb URL for a clothing variant.
 * Reads NEW shape `avatars.faceThumb.{variant}`, falls back to OLD shapes
 * `avatars.faceThumbnailsUrl.{variant}` and `avatars.faceThumbnails.{variant}`.
 *
 * @param {Object} character
 * @param {string} variant - 'standard' | 'winter' | 'summer'
 * @returns {string|null}
 */
function getFaceThumb(character, variant = 'standard') {
  if (!character) return null;
  const avatars = character.avatars && typeof character.avatars === 'object'
    ? character.avatars
    : character;
  if (!avatars || typeof avatars !== 'object') return null;
  // NEW
  const newVal = _toUrlString(avatars.faceThumb?.[variant]);
  if (newVal) return newVal;
  // OLD: URL siblings
  const oldUrl = _toUrlString(avatars.faceThumbnailsUrl?.[variant]);
  if (oldUrl) return oldUrl;
  // OLD: inline form
  const oldInline = _toUrlString(avatars.faceThumbnails?.[variant]);
  if (oldInline) return oldInline;
  return null;
}

/**
 * Get the body-thumb URL for a clothing variant.
 * Reads NEW `avatars.bodyThumb.{variant}` first, falls back to OLD
 * `avatars.bodyThumbnailsUrl.{variant}` / `avatars.bodyThumbnails.{variant}`.
 */
function getBodyThumb(character, variant = 'standard') {
  if (!character) return null;
  const avatars = character.avatars && typeof character.avatars === 'object'
    ? character.avatars
    : character;
  if (!avatars || typeof avatars !== 'object') return null;
  const newVal = _toUrlString(avatars.bodyThumb?.[variant]);
  if (newVal) return newVal;
  const oldUrl = _toUrlString(avatars.bodyThumbnailsUrl?.[variant]);
  if (oldUrl) return oldUrl;
  const oldInline = _toUrlString(avatars.bodyThumbnails?.[variant]);
  if (oldInline) return oldInline;
  return null;
}

/**
 * True when the character has at least one main avatar slot resolvable
 * (any variant, NEW or OLD shape).
 */
function hasAnyStandardAvatar(character) {
  if (!character) return false;
  return !!(getStandardAvatar(character, 'standard')
         || getStandardAvatar(character, 'winter')
         || getStandardAvatar(character, 'summer'));
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

  // First check normalized photos structure (NEW shape — post-migration)
  const photos = character.photos;
  if (photos?.face || photos?.original) {
    return photos.face || photos.original;
  }

  // Fallback to legacy top-level fields (OLD shape — pre-migration)
  return character.thumbnail_url
      || character.facePhoto
      || character.photo_url || character.photoUrl || character.photo
      || null;
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
 * Load avatar bytes for a slot from R2. Returns base64 string suitable for
 * sharp/Buffer decode, or null when no URL is set or the fetch failed.
 *
 * @param {Object} avatar - The avatars object from character.avatars
 * @param {string} slot   - 'standard' | 'summer' | 'winter'
 * @returns {Promise<string|null>} base64 string (no data: prefix) or null
 */
async function loadAvatarBytes(avatar, slot) {
  if (!avatar || !slot) return null;
  // Dual-shape: NEW `avatar[slot]` (URL string) wins, OLD `avatar[slotUrl]` falls back.
  // _toUrlString safely unwraps object/string forms. We only fetch when the value
  // is an http(s) URL — inline data: URIs are returned directly so we don't try to
  // fetch them, and we don't return base64 of the data-URI bytes (which the caller
  // wouldn't know how to decode either way).
  const candidate = getStandardAvatar(avatar, slot);
  if (!candidate) return null;
  if (/^https?:\/\//i.test(candidate)) return _getOrFetch(candidate);
  // Inline data URI — strip prefix and return raw base64 (matches legacy contract).
  if (candidate.startsWith('data:')) {
    const m = candidate.match(/^data:[^;]+;base64,(.*)$/);
    return m ? m[1] : null;
  }
  return null;
}

/**
 * Load Visual Bible reference image bytes from R2.
 *
 * @param {Object} vbEntry - A single VB entry (character/animal/artifact/etc.)
 * @returns {Promise<string|null>} base64 string (no data: prefix) or null
 */
async function loadVbReferenceBytes(vbEntry) {
  if (!vbEntry) return null;
  return _getOrFetch(vbEntry.referenceImageUrl);
}

/**
 * Normalize an avatars object for API responses.
 *
 * The DB stores R2 URLs in `*Url` siblings (`standardUrl`, `summerUrl`,
 * `winterUrl`, `faceThumbnailsUrl`, `bodyThumbnailsUrl`) while the primary
 * fields (`standard`, `summer`, `winter`, `faceThumbnails`, `bodyThumbnails`)
 * are nulled out post-Phase-5. The frontend's contract is "avatars.standard
 * is an image src string". This helper coalesces the URL siblings into the
 * primary fields and strips the `*Url` keys so the response has one obvious
 * source of truth per slot. Inline base64 (legacy rows) is kept as the
 * fallback when no URL exists.
 *
 * Also normalizes styled-avatar slots that the Phase 1e backfill turned
 * into `{imageUrl, imageData: null}` objects, collapsing them to a string.
 */
function normalizeAvatarsForResponse(avatars) {
  if (!avatars || typeof avatars !== 'object') return avatars;
  const out = { ...avatars };
  for (const slot of ['standard', 'summer', 'winter']) {
    const url = out[`${slot}Url`];
    if (url) out[slot] = url;
    delete out[`${slot}Url`];
  }
  for (const kind of ['face', 'body']) {
    const tk = `${kind}Thumbnails`;
    const uk = `${kind}ThumbnailsUrl`;
    const urls = out[uk];
    if (urls && typeof urls === 'object') {
      const merged = { ...(out[tk] || {}) };
      for (const k of Object.keys(urls)) if (urls[k]) merged[k] = urls[k];
      out[tk] = merged;
    }
    delete out[uk];
  }
  if (out.styledAvatars && typeof out.styledAvatars === 'object') {
    const styledOut = {};
    for (const [artStyle, slots] of Object.entries(out.styledAvatars)) {
      if (!slots || typeof slots !== 'object') { styledOut[artStyle] = slots; continue; }
      const slotsOut = {};
      for (const [slot, v] of Object.entries(slots)) {
        if (slot === 'costumed' && v && typeof v === 'object') {
          // Costumed: { costumeName: stringOrObject }
          const costumed = {};
          for (const [name, cv] of Object.entries(v)) {
            costumed[name] = (cv && typeof cv === 'object') ? (cv.imageUrl || cv.imageData || null) : cv;
          }
          slotsOut.costumed = costumed;
        } else if (v && typeof v === 'object') {
          slotsOut[slot] = v.imageUrl || v.imageData || null;
        } else {
          slotsOut[slot] = v;
        }
      }
      styledOut[artStyle] = slotsOut;
    }
    out.styledAvatars = styledOut;
  }
  return out;
}

/**
 * Walk a list of characters and replace each `avatars` with the normalized
 * shape. Mutates in place.
 */
function normalizeCharacterAvatars(characters) {
  if (!Array.isArray(characters)) return characters;
  for (const c of characters) {
    if (c?.avatars) c.avatars = normalizeAvatarsForResponse(c.avatars);
  }
  return characters;
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
  normalizeAvatarsForResponse,
  normalizeCharacterAvatars,
  // Phase 1 dual-shape readers
  getStandardAvatar,
  getFaceThumb,
  getBodyThumb,
  hasAnyStandardAvatar,
};
