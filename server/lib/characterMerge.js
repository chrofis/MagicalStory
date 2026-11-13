/**
 * Character merge logic - extracted for unit testing
 *
 * These functions handle merging character data during save operations,
 * preserving server-side data (avatars, photos) while accepting client updates.
 */

const { FIELD_MAPPINGS, HAIR_OVERRIDE_FIELD_TO_DETAILED_KEY, normalizePhysical, stripLegacyPhysicalFields } = require('./characterPhysical');
const { normalizeTraits, stripLegacyTraitFields } = require('./characterTraits');

/**
 * A character is the same character only when the ids match (compared as strings:
 * SQL/JSON give strings, the client numbers). NEVER by name: two characters may share
 * a name, and a nameless draft is '' for everyone. A character without an id matches nothing.
 * docs/decisions.md 2026-11-13 "Character save matches by id only".
 */
function sameCharacterId(a, b) {
  if (a?.id == null || b?.id == null) return false;
  return String(a.id) === String(b.id);
}

/** The DB character the sent character is, by id only; undefined when it is new. */
function findExistingCharacter(dbCharacters, newChar) {
  return (dbCharacters || []).find(c => sameCharacterId(c, newChar));
}

/** A key the form SENT (including '' and []) is the user's value; null/undefined count as absent. */
function isSent(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== null && obj[key] !== undefined;
}

/**
 * Canonical physical keys present in the RAW payload (before normalizePhysical):
 * either physical.<key> or its legacy flat key (eye_color, ...). The client sends the flat form.
 */
function sentPhysicalKeys(rawChar) {
  const sent = new Set();
  if (!rawChar) return sent;
  if (rawChar.physical && typeof rawChar.physical === 'object') {
    for (const k of Object.keys(rawChar.physical)) if (isSent(rawChar.physical, k)) sent.add(k);
  }
  for (const [legacy, canonical] of Object.entries(FIELD_MAPPINGS)) {
    if (isSent(rawChar, legacy)) sent.add(canonical);
  }
  return sent;
}

/**
 * Merge physical on save: a value the form sent wins, even when empty (the user cleared it);
 * only keys ABSENT from the payload keep the DB value.
 * newPhysical is the normalized new physical (non-empty values only come through normalize).
 */
function mergePhysicalOnSave(existingPhysical, newPhysical, sentKeys) {
  const merged = { ...existingPhysical };
  for (const [key, value] of Object.entries(newPhysical || {})) {
    if (value !== null && value !== undefined && value !== '') merged[key] = value;
  }
  for (const key of sentKeys || []) {
    const v = newPhysical?.[key];
    if (v === undefined || v === null || v === '') {
      merged[key] = '';
      // Hair shape lives in userHairOverride in storage: clearing it must clear the override too.
      const overrideKey = HAIR_OVERRIDE_FIELD_TO_DETAILED_KEY[key];
      if (overrideKey && merged.userHairOverride && typeof merged.userHairOverride === 'object') {
        const { [overrideKey]: _drop, ...rest } = merged.userHairOverride;
        merged.userHairOverride = rest;
      }
    }
  }
  return merged;
}

const TRAIT_SENT_KEYS = {
  strengths: ['strengths'],
  flaws: ['flaws', 'weaknesses'],
  challenges: ['challenges', 'fears'],
  specialDetails: ['specialDetails', 'special_details']
};

/** Canonical trait keys present in the RAW payload (traits.<key> or its legacy flat key). */
function sentTraitKeys(rawChar) {
  const sent = new Set();
  if (!rawChar) return sent;
  for (const [canonical, names] of Object.entries(TRAIT_SENT_KEYS)) {
    if (isSent(rawChar.traits, canonical) || names.some(n => isSent(rawChar, n))) sent.add(canonical);
  }
  return sent;
}

/** Merge traits on save: sent keys (even empty) win; absent keys keep the DB value. */
function mergeTraitsOnSave(existingTraits, newTraits, sentKeys) {
  const merged = { ...newTraits };
  for (const key of Object.keys(TRAIT_SENT_KEYS)) {
    if (sentKeys && sentKeys.has(key)) continue;
    const old = existingTraits?.[key];
    const has = Array.isArray(old) ? old.length > 0 : !!old;
    const cur = merged[key];
    const curEmpty = Array.isArray(cur) ? cur.length === 0 : !cur;
    if (has && curEmpty) merged[key] = old;
  }
  return merged;
}

/**
 * The save route's physical + traits merge for ONE character. Mutates existingChar (normalized)
 * and mergedChar (a shallow copy of the sent character): mergedChar ends with canonical
 * physical/traits and no legacy flat fields. Keys the form sent win even when empty.
 * @returns {{preservedPhysical: boolean}}
 */
function mergePhysicalAndTraitsOnSave(existingChar, mergedChar, newChar) {
  // Sent-ness must be read from the raw payload, before normalization drops empty legacy values.
  const sentPhysical = sentPhysicalKeys(newChar);
  const sentTraits = sentTraitKeys(newChar);

  normalizePhysical(existingChar);
  normalizePhysical(mergedChar);
  const existingPhysical = existingChar.physical || {};
  const newPhysical = mergedChar.physical || {};
  let preservedPhysical = false;
  if (Object.keys(existingPhysical).length > 0) {
    mergedChar.physical = mergePhysicalOnSave(existingPhysical, newPhysical, sentPhysical);
    preservedPhysical = Object.keys(existingPhysical).some(k => !newPhysical[k] && !sentPhysical.has(k));
  }
  stripLegacyPhysicalFields(mergedChar);

  normalizeTraits(existingChar);
  normalizeTraits(mergedChar);
  const existingTraits = existingChar.traits || {};
  const newTraits = mergedChar.traits || {};
  if (Object.keys(existingTraits).length > 0) {
    mergedChar.traits = mergeTraitsOnSave(existingTraits, newTraits, sentTraits);
  }
  stripLegacyTraitFields(mergedChar);
  return { preservedPhysical };
}

/**
 * Merge avatars from DB with metadata from frontend
 *
 * Strategy: DB avatars are source of truth for images (avatar generation saves directly to DB)
 * Frontend only sends metadata (status, generatedAt, stale)
 *
 * @param {Object} existingAvatars - Avatars from database (full data with images)
 * @param {Object} newAvatars - Avatars from frontend (metadata only, stripped)
 * @returns {Object|null} - Merged avatars or null if both are empty
 */
function mergeAvatars(existingAvatars, newAvatars) {
  // No avatars at all
  if (!existingAvatars && !newAvatars) {
    return null;
  }

  // Start with DB avatars (has all images, thumbnails, etc.)
  // If no DB avatars but frontend sent something, use frontend as base
  const merged = existingAvatars
    ? { ...existingAvatars }
    : { ...newAvatars };

  // Update metadata from frontend if provided
  if (newAvatars?.status) merged.status = newAvatars.status;
  if (newAvatars?.generatedAt) merged.generatedAt = newAvatars.generatedAt;
  if (newAvatars?.stale !== undefined) merged.stale = newAvatars.stale;

  return merged;
}

/**
 * Merge a single character's data
 * Preserves server-side data (avatars, photos, physical traits) while accepting frontend updates
 *
 * @param {Object} newChar - Character data from frontend
 * @param {Object|null} existingChar - Existing character from database
 * @returns {{ merged: Object, preserved: string[] }} - Merged character and list of preserved fields
 */
function mergeCharacter(newChar, existingChar) {
  const preservedFields = [];

  // No existing data - return new character as-is
  if (!existingChar) {
    return { merged: newChar, preserved: [] };
  }

  let mergedChar = { ...newChar };

  // Preserve character-level fields that may be missing from frontend
  const simplePreserveFields = [
    'height', 'apparent_age', 'build', 'eye_color',
    'hair_color', 'hair_style', 'other_features', 'other', 'clothing'
  ];

  for (const field of simplePreserveFields) {
    if (existingChar[field] && !newChar[field]) {
      mergedChar[field] = existingChar[field];
      preservedFields.push(field);
    }
  }

  // Preserve structuredClothing (structured format with upperBody, lowerBody, shoes, fullBody)
  mergedChar.structuredClothing = mergeStructuredClothing(
    existingChar.structuredClothing,
    newChar.structuredClothing
  );
  if (mergedChar.structuredClothing && !hasRealClothingValues(newChar.structuredClothing)) {
    preservedFields.push('structuredClothing');
  }

  // Preserve physical traits object
  const mergedPhysical = mergePhysicalTraits(existingChar.physical, newChar.physical);
  if (mergedPhysical) {
    mergedChar.physical = mergedPhysical;
    if (isPhysicalEmpty(newChar.physical) && !isPhysicalEmpty(existingChar.physical)) {
      preservedFields.push('physical');
    }
  }

  // Preserve photos object
  if (existingChar.photos && !newChar.photos) {
    mergedChar.photos = existingChar.photos;
    preservedFields.push('photos');
  } else if (existingChar.photos && newChar.photos) {
    mergedChar.photos = { ...existingChar.photos, ...newChar.photos };
  }

  // Preserve photo URLs (large base64 data)
  const photoFields = ['photo_url', 'thumbnail_url', 'body_photo_url', 'body_no_bg_url'];
  for (const field of photoFields) {
    if (existingChar[field] && !newChar[field]) {
      mergedChar[field] = existingChar[field];
      preservedFields.push(field);
    }
  }

  // Merge avatars (DB avatars + frontend metadata)
  const mergedAvatars = mergeAvatars(existingChar.avatars, newChar.avatars);
  if (mergedAvatars) {
    mergedChar.avatars = mergedAvatars;
  }

  return { merged: mergedChar, preserved: preservedFields };
}

/**
 * Merge structured clothing data
 */
function mergeStructuredClothing(existing, incoming) {
  const incomingEmpty = !incoming || (typeof incoming === 'object' && Object.keys(incoming).length === 0);

  if (existing && incomingEmpty) {
    return existing;
  }

  if (existing && !incomingEmpty) {
    // Check if incoming has actual values
    if (!hasRealClothingValues(incoming)) {
      return existing;
    }
    return incoming;
  }

  return incoming;
}

/**
 * Check if structured clothing has real values (not all empty)
 */
function hasRealClothingValues(clothing) {
  if (!clothing) return false;
  return !!(clothing.upperBody || clothing.lowerBody || clothing.fullBody || clothing.shoes);
}

/**
 * Merge physical traits objects
 */
function mergePhysicalTraits(existing, incoming) {
  const existingHasData = existing && Object.keys(existing).length > 0;
  const incomingEmpty = isPhysicalEmpty(incoming);

  if (existingHasData && incomingEmpty) {
    return existing;
  }

  if (existingHasData) {
    // Merge - keep existing values for any missing/empty fields in new
    const merged = { ...existing };
    for (const [key, value] of Object.entries(incoming || {})) {
      if (value !== null && value !== undefined && value !== '') {
        merged[key] = value;
      }
    }
    return merged;
  }

  return incoming;
}

/**
 * Check if physical traits object is empty or has no real values
 */
function isPhysicalEmpty(physical) {
  if (!physical) return true;
  if (Object.keys(physical).length === 0) return true;
  return !Object.values(physical).some(v => v !== null && v !== undefined && v !== '');
}

/**
 * Strip heavy fields from character for metadata storage
 * Keeps only data needed for list views.
 *
 * Dual-shape (Phase 1 migration): the standard face thumbnail used for the
 * list view exists under TWO possible field names depending on whether the
 * row has been migrated yet:
 *   NEW (post-migration): avatars.faceThumb.standard         (URL string)
 *   OLD (pre-migration):  avatars.faceThumbnailsUrl.standard (URL string)
 *                         avatars.faceThumbnails.standard    (inline string)
 *
 * We read NEW first, then OLD. CRITICAL: this drives the list-view SQL —
 * if the read fails post-migration, every character card loses its avatar.
 *
 * Writes still go to the OLD shape (`faceThumbnails`) — that's what the
 * generation pipeline produces today. The migration script will rewrite
 * these to the NEW shape (`faceThumb`) on DB rows that have been migrated;
 * fresh data from new generations continues to land in `faceThumbnails`
 * until Phase 3 (writer cleanup) runs.
 */
function createLightCharacter(char) {
  // Remove heavy base64 fields
  const { body_no_bg_url, body_photo_url, photo_url, clothing_avatars, ...lightChar } = char;

  // Keep avatar metadata + only 'standard' faceThumbnail for list display
  if (lightChar.avatars) {
    const av = lightChar.avatars;
    // NEW shape first (faceThumb), then OLD fallbacks (faceThumbnailsUrl, faceThumbnails)
    const standardThumb = av.faceThumb?.standard
                        || av.faceThumbnailsUrl?.standard
                        || av.faceThumbnails?.standard;
    lightChar.avatars = {
      status: av.status,
      stale: av.stale,
      generatedAt: av.generatedAt,
      hasFullAvatars: !!(av.standard || av.standardUrl),
      // Keep writing under the OLD field name during Phase 1 — the list-view
      // SQL/UI still reads `faceThumbnails.standard`. Phase 3 will rename
      // both the write and read sides once all rows are migrated.
      faceThumbnails: standardThumb ? { standard: standardThumb } : undefined,
      clothing: av.clothing
    };
  }

  return lightChar;
}

/**
 * Merge array of characters with existing data
 */
function mergeCharacters(newCharacters, existingCharacters) {
  let preservedCount = 0;

  const merged = (newCharacters || []).map(newChar => {
    const existingChar = (existingCharacters || []).find(
      c => sameCharacterId(c, newChar)
    );

    const { merged: mergedChar, preserved } = mergeCharacter(newChar, existingChar);

    if (preserved.length > 0) {
      preservedCount++;
    }

    return mergedChar;
  });

  return { characters: merged, preservedCount };
}

module.exports = {
  mergePhysicalAndTraitsOnSave,
  sameCharacterId,
  findExistingCharacter,
  sentPhysicalKeys,
  mergePhysicalOnSave,
  sentTraitKeys,
  mergeTraitsOnSave,
  mergeAvatars,
  mergeCharacter,
  mergeCharacters,
  mergeStructuredClothing,
  mergePhysicalTraits,
  hasRealClothingValues,
  isPhysicalEmpty,
  createLightCharacter
};
