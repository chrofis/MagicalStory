/**
 * Character photo / avatar URL helpers — dual-shape readers (Phase 1).
 *
 * During the staged character-photo-fields migration, character rows exist
 * in TWO shapes simultaneously:
 *
 *   OLD shape (pre-migration)              NEW shape (post-migration)
 *   ──────────────────────────             ─────────────────────────────
 *   avatars.standardUrl (URL)              avatars.standard (URL string)
 *   avatars.standard    (inline / object)      ↑
 *   avatars.faceThumbnailsUrl.{v}          avatars.faceThumb.{v}
 *   avatars.faceThumbnails.{v}                 ↑
 *   avatars.bodyThumbnailsUrl.{v}          avatars.bodyThumb.{v}
 *   avatars.bodyThumbnails.{v}
 *
 * These helpers read NEW first, then fall back to OLD, so both pre- and
 * post-migration data render identically. They always return a string (URL
 * or data: URI) or `null` — never an object, never `undefined`.
 *
 * Mirror of `server/lib/characterPhotos.js` — keep the two in sync.
 */

import type { Character } from '../types/character';

// Read either a character or a sub-avatars object — both common in practice.
type CharOrAvatars = Character | { avatars?: unknown } | Record<string, unknown> | null | undefined;
type Variant = 'standard' | 'winter' | 'summer';

/**
 * Pull a non-empty string out of a value that might be:
 *  - a plain string (URL or data: URI)
 *  - an object like { url, imageUrl, src, dataUri, imageData, data, image }
 *  - null / undefined / "" / anything else
 *
 * Returns the trimmed string or null.
 */
function toUrlString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const t = value.trim();
    return t || null;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = ['url', 'imageUrl', 'src', 'dataUri', 'imageData', 'data', 'image'] as const;
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

/**
 * Extract the avatars sub-object from either a Character or a bare avatars
 * object — we accept both shapes for ergonomics (call sites often have one
 * or the other handy).
 */
function getAvatars(input: CharOrAvatars): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null;
  const maybeChar = input as { avatars?: unknown };
  if (maybeChar.avatars && typeof maybeChar.avatars === 'object') {
    return maybeChar.avatars as Record<string, unknown>;
  }
  // Caller passed an avatars-shaped object directly
  return input as Record<string, unknown>;
}

/**
 * Main avatar URL for a clothing variant (the 2x2 grid image, post-styling).
 * NEW shape: `avatars.{variant}` is a URL string.
 * OLD shape: `avatars.{variant}Url` is a URL, `avatars.{variant}` may be a
 *   string (data URI) or an object ({ imageUrl, imageData }).
 *
 * Returns a URL string, a data: URI, or null. Never an object.
 */
export function getStandardAvatar(input: CharOrAvatars, variant: Variant = 'standard'): string | null {
  const av = getAvatars(input);
  if (!av) return null;
  const newVal = toUrlString(av[variant]);
  if (newVal) return newVal;
  const oldUrl = toUrlString(av[`${variant}Url`]);
  if (oldUrl) return oldUrl;
  return null;
}

/**
 * Face-thumb URL for a clothing variant.
 * NEW: avatars.faceThumb.{variant}    OLD: avatars.faceThumbnailsUrl.{variant}
 *                                          or avatars.faceThumbnails.{variant}
 */
export function getFaceThumb(input: CharOrAvatars, variant: Variant = 'standard'): string | null {
  const av = getAvatars(input);
  if (!av) return null;
  const newObj = av.faceThumb as Record<string, unknown> | undefined;
  if (newObj && typeof newObj === 'object') {
    const v = toUrlString(newObj[variant]);
    if (v) return v;
  }
  const oldUrlObj = av.faceThumbnailsUrl as Record<string, unknown> | undefined;
  if (oldUrlObj && typeof oldUrlObj === 'object') {
    const v = toUrlString(oldUrlObj[variant]);
    if (v) return v;
  }
  const oldInlineObj = av.faceThumbnails as Record<string, unknown> | undefined;
  if (oldInlineObj && typeof oldInlineObj === 'object') {
    const v = toUrlString(oldInlineObj[variant]);
    if (v) return v;
  }
  return null;
}

/**
 * Body-thumb URL for a clothing variant.
 * NEW: avatars.bodyThumb.{variant}    OLD: avatars.bodyThumbnailsUrl.{variant}
 *                                          or avatars.bodyThumbnails.{variant}
 */
export function getBodyThumb(input: CharOrAvatars, variant: Variant = 'standard'): string | null {
  const av = getAvatars(input);
  if (!av) return null;
  const newObj = av.bodyThumb as Record<string, unknown> | undefined;
  if (newObj && typeof newObj === 'object') {
    const v = toUrlString(newObj[variant]);
    if (v) return v;
  }
  const oldUrlObj = av.bodyThumbnailsUrl as Record<string, unknown> | undefined;
  if (oldUrlObj && typeof oldUrlObj === 'object') {
    const v = toUrlString(oldUrlObj[variant]);
    if (v) return v;
  }
  const oldInlineObj = av.bodyThumbnails as Record<string, unknown> | undefined;
  if (oldInlineObj && typeof oldInlineObj === 'object') {
    const v = toUrlString(oldInlineObj[variant]);
    if (v) return v;
  }
  return null;
}

/**
 * Pick a display photo for a character. Common pattern across UI:
 *   "AI-extracted face thumb (standard) → uploaded face → uploaded original"
 *
 * Uses the dual-shape face-thumb reader for the first leg.
 */
export function getDisplayPhoto(input: CharOrAvatars): string | null {
  const thumb = getFaceThumb(input, 'standard');
  if (thumb) return thumb;
  const char = (input && typeof input === 'object' && 'photos' in (input as object))
    ? (input as { photos?: { face?: string; original?: string } })
    : null;
  if (char?.photos?.face) return char.photos.face;
  if (char?.photos?.original) return char.photos.original;
  return null;
}

/**
 * Pick the best INPUT photo for avatar generation (clothing avatars, styled
 * avatars, etc.). Order of preference:
 *   1. body-no-bg (clean cut-out, preferred — server inpaints cleanest)
 *   2. body (raw upload with background)
 *   3. face (head crop)
 *   4. original (raw upload)
 *   5. Legacy top-level fields (pre-photos.* normalization)
 *
 * Mirrors server-side `getBodyPhoto` in characterPhotos.js but with a wider
 * fallback chain — call sites need a SOMETHING-not-null to send as
 * `referencePhoto` to the avatar-generation endpoints; UI thumbnails can use
 * getDisplayPhoto instead.
 */
export function getAvatarInputPhoto(input: CharOrAvatars): string | null {
  if (!input || typeof input !== 'object') return null;
  const c = input as Record<string, unknown>;
  const photos = c.photos as Record<string, unknown> | undefined;
  const fromPhotos = toUrlString(photos?.bodyNoBg)
    || toUrlString(photos?.body)
    || toUrlString(photos?.face)
    || toUrlString(photos?.original);
  if (fromPhotos) return fromPhotos;
  // Legacy top-level fields (pre-normalization characters)
  const legacy = toUrlString(c.body_no_bg_url) || toUrlString(c.bodyNoBgUrl)
    || toUrlString(c.body_photo_url) || toUrlString(c.bodyPhotoUrl)
    || toUrlString(c.thumbnail_url)
    || toUrlString(c.photo_url) || toUrlString(c.photoUrl) || toUrlString(c.photo)
    || toUrlString(c.facePhoto);
  if (legacy) return legacy;
  // Last-resort fallback: characters that lost their raw photo but still have
  // generated avatars (typical of older accounts — only avatars.standardUrl /
  // avatars.faceThumbnailsUrl survive). The standard avatar is a full-body
  // image of the same person in standard clothing — close enough to a raw
  // photo for avatar-regen-style endpoints to use as input. Without this,
  // regen 400s on every legacy character.
  const standardAvatar = getStandardAvatar(c, 'standard') || getStandardAvatar(c, 'winter') || getStandardAvatar(c, 'summer');
  if (standardAvatar) return standardAvatar;
  const bodyThumb = getBodyThumb(c, 'standard') || getBodyThumb(c, 'winter') || getBodyThumb(c, 'summer');
  if (bodyThumb) return bodyThumb;
  const faceThumb = getFaceThumb(c, 'standard') || getFaceThumb(c, 'winter') || getFaceThumb(c, 'summer');
  if (faceThumb) return faceThumb;
  return null;
}
