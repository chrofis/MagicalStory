/**
 * Character merge logic - extracted for unit testing
 *
 * These functions handle merging character data during save operations,
 * preserving server-side data (avatars, photos) while accepting client updates.
 */

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

  // Preserve structured_clothing (new structured format)
  mergedChar.structured_clothing = mergeStructuredClothing(
    existingChar.structured_clothing,
    newChar.structured_clothing
  );
  if (mergedChar.structured_clothing && !hasRealClothingValues(newChar.structured_clothing)) {
    preservedFields.push('structured_clothing');
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
 * Keeps only data needed for list views
 */
function createLightCharacter(char) {
  // Remove heavy base64 fields
  const { body_no_bg_url, body_photo_url, photo_url, clothing_avatars, ...lightChar } = char;

  // Keep avatar metadata + only 'standard' faceThumbnail for list display
  if (lightChar.avatars) {
    const standardThumb = lightChar.avatars.faceThumbnails?.standard;
    lightChar.avatars = {
      status: lightChar.avatars.status,
      stale: lightChar.avatars.stale,
      generatedAt: lightChar.avatars.generatedAt,
      hasFullAvatars: !!(lightChar.avatars.winter || lightChar.avatars.standard || lightChar.avatars.summer || lightChar.avatars.formal),
      faceThumbnails: standardThumb ? { standard: standardThumb } : undefined,
      clothing: lightChar.avatars.clothing
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
      c => c.id === newChar.id || c.name === newChar.name
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
  mergeAvatars,
  mergeCharacter,
  mergeCharacters,
  mergeStructuredClothing,
  mergePhysicalTraits,
  hasRealClothingValues,
  isPhysicalEmpty,
  createLightCharacter
};
